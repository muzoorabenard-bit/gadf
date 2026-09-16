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

// The reverse lookup: find a contact's phone number by name, used when the
// user tells gadf to text someone Dero has no WhatsApp history with yet.
export async function searchContactsByName(token: string, name: string): Promise<Array<{ name: string; phoneNumber: string }>> {
  const res = await fetch(
    `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(name)}&readMask=names,phoneNumbers`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    console.error("People API search failed:", await res.text());
    return [];
  }
  const data = await res.json();
  const matches: Array<{ name: string; phoneNumber: string }> = [];
  for (const result of data.results ?? []) {
    const displayName = result.person?.names?.[0]?.displayName;
    const phoneNumber = result.person?.phoneNumbers?.[0]?.canonicalForm ?? result.person?.phoneNumbers?.[0]?.value;
    if (displayName && phoneNumber) matches.push({ name: displayName, phoneNumber });
  }
  return matches;
}
