// People API lookup, used to resolve a real contact name for a WhatsApp
// number when WhatsApp itself gives no (or an unhelpful) profile name.
// Requires the contacts.readonly scope, granted separately from
// Drive/Calendar -- callers should treat a null result as "not found or
// not authorized yet", not an error.
export async function lookupContactByPhone(token: string, phoneNumber: string): Promise<string | null> {
  const res = await fetch(
    `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(phoneNumber)}&readMask=names,phoneNumbers`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    console.error("People API search failed:", await res.text());
    return null;
  }
  const data = await res.json();
  for (const result of data.results ?? []) {
    const name = result.person?.names?.[0]?.displayName;
    if (name) return name as string;
  }
  return null;
}
