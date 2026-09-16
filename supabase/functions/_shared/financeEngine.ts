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
