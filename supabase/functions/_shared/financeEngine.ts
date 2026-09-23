import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Deterministic financial calculations for Lydia. Every number here is
// computed in code from actual rows — never by asking an LLM to do
// arithmetic — so a report is always traceable back to real data. Where a
// component genuinely isn't known (no balance yet, no reserve configured),
// that's returned explicitly rather than silently treated as zero.

interface AccountBalance {
  accountId: string;
  name: string;
  type: string;
  balance: number | null; // null = no balance_after recorded yet for this account
  asOf: string | null;
}

export async function getAccountBalances(supabase: SupabaseClient, userId: string): Promise<AccountBalance[]> {
  const { data: accounts } = await supabase
    .from("financial_accounts")
    .select("id, name, type")
    .eq("user_id", userId);

  const results: AccountBalance[] = [];
  for (const account of accounts ?? []) {
    const { data: latest } = await supabase
      .from("transactions")
      .select("balance_after, occurred_at")
      .eq("user_id", userId)
      .eq("account_id", account.id)
      .eq("parse_status", "parsed")
      .not("balance_after", "is", null)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    results.push({
      accountId: account.id,
      name: account.name,
      type: account.type,
      balance: latest?.balance_after ?? null,
      asOf: latest?.occurred_at ?? null,
    });
  }
  return results;
}

interface IncomeExpense {
  income: number;
  expense: number;
  net: number;
  transferCount: number;
  transactionCount: number;
}

export async function getIncomeExpense(
  supabase: SupabaseClient,
  userId: string,
  startDate?: string,
  endDate?: string,
): Promise<IncomeExpense> {
  let query = supabase
    .from("transactions")
    .select("transaction_type, amount, is_transfer")
    .eq("user_id", userId)
    .eq("parse_status", "parsed");
  if (startDate) query = query.gte("occurred_at", startDate);
  if (endDate) query = query.lt("occurred_at", endDate);

  const { data } = await query;
  let income = 0;
  let expense = 0;
  let transferCount = 0;
  for (const t of data ?? []) {
    if (t.is_transfer) {
      transferCount += 1;
      continue;
    }
    const amount = Number(t.amount) || 0;
    if (t.transaction_type === "receive" || t.transaction_type === "deposit") income += amount;
    else if (["send", "payment", "withdraw", "airtime"].includes(t.transaction_type)) expense += amount;
  }
  return { income, expense, net: income - expense, transferCount, transactionCount: data?.length ?? 0 };
}

export async function getCommitmentsTotal(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data } = await supabase
    .from("commitments")
    .select("amount")
    .eq("user_id", userId)
    .eq("status", "pending");
  return (data ?? []).reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
}

export async function getReceivablesTotal(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data } = await supabase
    .from("receivables")
    .select("amount")
    .eq("user_id", userId)
    .eq("status", "pending");
  return (data ?? []).reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
}

interface SafeToSpend {
  totalCash: number;
  accountsWithUnknownBalance: string[];
  businessProjectFunds: number;
  commitments: number;
  essentialExpenses: number | null; // null = not configured
  protectedReserve: number | null; // null = not configured
  discretionary: number;
  notes: string[];
}

export async function calculateSafeToSpend(supabase: SupabaseClient, userId: string): Promise<SafeToSpend> {
  const [balances, commitments, { data: settings }, businessFunds] = await Promise.all([
    getAccountBalances(supabase, userId),
    getCommitmentsTotal(supabase, userId),
    supabase.from("financial_settings").select("protected_reserve, essential_monthly_expenses").eq("user_id", userId).maybeSingle(),
    // Cash sitting in transactions explicitly tagged business/project purpose isn't really discretionary personal cash.
    supabase
      .from("transactions")
      .select("amount, transaction_type, is_transfer")
      .eq("user_id", userId)
      .eq("parse_status", "parsed")
      .eq("purpose_type", "business")
      .not("account_id", "is", null),
  ]);

  const notes: string[] = [];
  const accountsWithUnknownBalance = balances.filter((b) => b.balance === null).map((b) => b.name);
  if (accountsWithUnknownBalance.length) {
    notes.push(`No balance yet recorded for: ${accountsWithUnknownBalance.join(", ")} — excluded from total cash rather than assumed zero.`);
  }
  const totalCash = balances.reduce((sum, b) => sum + (b.balance ?? 0), 0);

  let businessProjectFunds = 0;
  for (const t of businessFunds.data ?? []) {
    if (t.is_transfer) continue;
    const amount = Number(t.amount) || 0;
    if (t.transaction_type === "receive" || t.transaction_type === "deposit") businessProjectFunds += amount;
    else if (["send", "payment", "withdraw", "airtime"].includes(t.transaction_type)) businessProjectFunds -= amount;
  }
  businessProjectFunds = Math.max(0, businessProjectFunds);

  const essentialExpenses = settings?.essential_monthly_expenses ?? null;
  const protectedReserve = settings?.protected_reserve ?? null;
  if (essentialExpenses === null) notes.push("Essential monthly expenses aren't configured yet — not subtracted.");
  if (protectedReserve === null) notes.push("No protected reserve amount is configured yet — not subtracted.");

  const discretionary =
    totalCash - businessProjectFunds - commitments - (essentialExpenses ?? 0) - (protectedReserve ?? 0);

  return {
    totalCash,
    accountsWithUnknownBalance,
    businessProjectFunds,
    commitments,
    essentialExpenses,
    protectedReserve,
    discretionary,
    notes,
  };
}

interface CategorySpending {
  categoryName: string;
  total: number;
  transactionCount: number;
}

export async function getCategorySpending(
  supabase: SupabaseClient,
  userId: string,
  startDate?: string,
  endDate?: string,
): Promise<CategorySpending[]> {
  let query = supabase
    .from("transactions")
    .select("amount, category_id, categories(name)")
    .eq("user_id", userId)
    .eq("parse_status", "parsed")
    .eq("is_transfer", false)
    .in("transaction_type", ["send", "payment", "withdraw", "airtime"]);
  if (startDate) query = query.gte("occurred_at", startDate);
  if (endDate) query = query.lt("occurred_at", endDate);

  const { data } = await query;
  const byCategory = new Map<string, CategorySpending>();
  for (const t of data ?? []) {
    // deno-lint-ignore no-explicit-any
    const name = (t as any).categories?.name ?? "Uncategorized";
    const entry = byCategory.get(name) ?? { categoryName: name, total: 0, transactionCount: 0 };
    entry.total += Number(t.amount) || 0;
    entry.transactionCount += 1;
    byCategory.set(name, entry);
  }
  return [...byCategory.values()].sort((a, b) => b.total - a.total);
}

interface EntityFinancials {
  name: string;
  received: number;
  spent: number;
  cashPosition: number; // never called "profit" — accounting basis isn't defined here
  transactionCount: number;
}

export async function getBusinessFinancials(supabase: SupabaseClient, userId: string): Promise<EntityFinancials[]> {
  const { data: businesses } = await supabase.from("businesses").select("id, name").eq("user_id", userId);
  const results: EntityFinancials[] = [];
  for (const b of businesses ?? []) {
    const { data } = await supabase
      .from("transactions")
      .select("amount, transaction_type, is_transfer")
      .eq("user_id", userId)
      .eq("business_id", b.id)
      .eq("parse_status", "parsed");
    let received = 0;
    let spent = 0;
    for (const t of data ?? []) {
      if (t.is_transfer) continue;
      const amount = Number(t.amount) || 0;
      if (t.transaction_type === "receive" || t.transaction_type === "deposit") received += amount;
      else if (["send", "payment", "withdraw", "airtime"].includes(t.transaction_type)) spent += amount;
    }
    results.push({ name: b.name, received, spent, cashPosition: received - spent, transactionCount: data?.length ?? 0 });
  }
  return results;
}

interface EmergencyFundProgress {
  currentCash: number;
  target: number | null;
  progressPct: number | null;
  configured: boolean;
}

export async function getEmergencyFundProgress(supabase: SupabaseClient, userId: string): Promise<EmergencyFundProgress> {
  const [balances, { data: settings }] = await Promise.all([
    getAccountBalances(supabase, userId),
    supabase.from("financial_settings").select("protected_reserve").eq("user_id", userId).maybeSingle(),
  ]);
  const currentCash = balances.reduce((sum, b) => sum + (b.balance ?? 0), 0);
  const target = settings?.protected_reserve ?? null;
  if (target === null || target <= 0) return { currentCash, target: null, progressPct: null, configured: false };
  return { currentCash, target, progressPct: Math.min(100, (currentCash / target) * 100), configured: true };
}

interface DebtPriorityItem {
  id: string;
  description: string;
  amount: number;
  interestRate: number | null;
  dueDate: string | null;
}

// Debt avalanche: highest interest rate first, since that's what's actually
// costing the most regardless of balance size. A commitment with no rate
// configured sorts last rather than being assumed to cost 0%.
export async function getDebtPayoffPriority(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ prioritized: DebtPriorityItem[]; anyRatesConfigured: boolean }> {
  const { data } = await supabase
    .from("commitments")
    .select("id, description, amount, interest_rate, due_date")
    .eq("user_id", userId)
    .eq("status", "pending");

  const items: DebtPriorityItem[] = (data ?? []).map((c) => ({
    id: c.id,
    description: c.description,
    amount: Number(c.amount) || 0,
    interestRate: c.interest_rate === null || c.interest_rate === undefined ? null : Number(c.interest_rate),
    dueDate: c.due_date,
  }));

  const prioritized = [...items].sort((a, b) => {
    if (a.interestRate === null && b.interestRate === null) return 0;
    if (a.interestRate === null) return 1;
    if (b.interestRate === null) return -1;
    return b.interestRate - a.interestRate;
  });

  return { prioritized, anyRatesConfigured: items.some((i) => i.interestRate !== null) };
}

interface LifestyleInflationCheck {
  currentMonth: IncomeExpense;
  previousMonth: IncomeExpense;
  incomeGrowthPct: number | null;
  expenseGrowthPct: number | null;
  flagged: boolean;
}

// Flags when spending is growing faster than income month over month --
// the classic lifestyle-inflation pattern where a raise quietly gets
// absorbed by higher spending instead of building wealth.
export async function getLifestyleInflationCheck(supabase: SupabaseClient, userId: string): Promise<LifestyleInflationCheck> {
  const now = new Date();
  const currentStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();

  const [currentMonth, previousMonth] = await Promise.all([
    getIncomeExpense(supabase, userId, currentStart),
    getIncomeExpense(supabase, userId, previousStart, currentStart),
  ]);

  const incomeGrowthPct = previousMonth.income > 0 ? ((currentMonth.income - previousMonth.income) / previousMonth.income) * 100 : null;
  const expenseGrowthPct = previousMonth.expense > 0 ? ((currentMonth.expense - previousMonth.expense) / previousMonth.expense) * 100 : null;
  const flagged = incomeGrowthPct !== null && expenseGrowthPct !== null && incomeGrowthPct > 0 && expenseGrowthPct > incomeGrowthPct;

  return { currentMonth, previousMonth, incomeGrowthPct, expenseGrowthPct, flagged };
}

interface BigThreeCheck {
  housingSpend: number;
  transportSpend: number;
  foodSpend: number;
  totalBigThree: number;
  income: number;
  bigThreePct: number | null;
  flagged: boolean;
}

// The "big three" (housing/transport/food) benchmark: flags when they
// together cross ~60% of income, the point where wealth-building becomes
// genuinely hard regardless of budgeting discipline elsewhere.
export async function getBigThreeRatio(
  supabase: SupabaseClient,
  userId: string,
  startDate?: string,
  endDate?: string,
): Promise<BigThreeCheck> {
  const { data: categories } = await supabase.from("categories").select("id, name, parent_id").eq("user_id", userId);
  const categoryById = new Map((categories ?? []).map((c) => [c.id, c]));

  function rootName(categoryId: string | null): string | null {
    let current = categoryId ? categoryById.get(categoryId) : undefined;
    let guard = 0;
    while (current?.parent_id && guard < 10) {
      current = categoryById.get(current.parent_id);
      guard += 1;
    }
    return current?.name ?? null;
  }

  let txQuery = supabase
    .from("transactions")
    .select("amount, category_id")
    .eq("user_id", userId)
    .eq("parse_status", "parsed")
    .eq("is_transfer", false)
    .in("transaction_type", ["send", "payment", "withdraw", "airtime"]);
  if (startDate) txQuery = txQuery.gte("occurred_at", startDate);
  if (endDate) txQuery = txQuery.lt("occurred_at", endDate);

  const [{ data: transactions }, income] = await Promise.all([txQuery, getIncomeExpense(supabase, userId, startDate, endDate)]);

  let housingSpend = 0;
  let transportSpend = 0;
  let foodSpend = 0;
  for (const t of transactions ?? []) {
    const root = rootName(t.category_id);
    const amount = Number(t.amount) || 0;
    if (root === "Housing") housingSpend += amount;
    else if (root === "Transport") transportSpend += amount;
    else if (root === "Food") foodSpend += amount;
  }

  const totalBigThree = housingSpend + transportSpend + foodSpend;
  const bigThreePct = income.income > 0 ? (totalBigThree / income.income) * 100 : null;
  return { housingSpend, transportSpend, foodSpend, totalBigThree, income: income.income, bigThreePct, flagged: (bigThreePct ?? 0) >= 60 };
}

export async function getProjectFinancials(supabase: SupabaseClient, userId: string): Promise<EntityFinancials[]> {
  const { data: projects } = await supabase.from("projects").select("id, name").eq("user_id", userId);
  const results: EntityFinancials[] = [];
  for (const p of projects ?? []) {
    const { data } = await supabase
      .from("transactions")
      .select("amount, transaction_type, is_transfer")
      .eq("user_id", userId)
      .eq("project_id", p.id)
      .eq("parse_status", "parsed");
    let received = 0;
    let spent = 0;
    for (const t of data ?? []) {
      if (t.is_transfer) continue;
      const amount = Number(t.amount) || 0;
      if (t.transaction_type === "receive" || t.transaction_type === "deposit") received += amount;
      else if (["send", "payment", "withdraw", "airtime"].includes(t.transaction_type)) spent += amount;
    }
    results.push({ name: p.name, received, spent, cashPosition: received - spent, transactionCount: data?.length ?? 0 });
  }
  return results;
}
