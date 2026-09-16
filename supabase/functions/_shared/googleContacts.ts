// People API lookups for Dero. searchContacts (Google's own search endpoint)
// relies on a server-side cache that only warms up after repeated use and
// was unreliably missing real contacts in testing -- so instead this fetches
// the user's contacts directly (paginated, up to 5000) and matches
// client-side, which is slower per call but actually reliable.

interface ContactEntry {
  name: string;
  phoneNumbers: string[];
}

async function listAllContacts(token: string): Promise<ContactEntry[]> {
  const contacts: ContactEntry[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const params = new URLSearchParams({ personFields: "names,phoneNumbers", pageSize: "1000" });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`https://people.googleapis.com/v1/people/me/connections?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error("People API connections.list failed:", await res.text());
      break;
    }
    const data = await res.json();
    for (const person of data.connections ?? []) {
      const name = person.names?.[0]?.displayName;
      const phoneNumbers = (person.phoneNumbers ?? [])
        .map((p: { canonicalForm?: string; value?: string }) => p.canonicalForm ?? p.value)
        .filter((v: string | undefined): v is string => Boolean(v));
      if (name && phoneNumbers.length) contacts.push({ name, phoneNumbers });
    }
    pageToken = data.nextPageToken;
    pages++;
  } while (pageToken && pages < 5);

  return contacts;
}

function digitsMatch(a: string, b: string): boolean {
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  if (!da || !db) return false;
  const shortLen = Math.min(da.length, db.length, 9);
  return da.slice(-shortLen) === db.slice(-shortLen);
}

// Used to resolve a real contact name for a WhatsApp number when WhatsApp
// itself gives no (or an unhelpful) profile name.
export async function lookupContactByPhone(token: string, phoneNumber: string): Promise<string | null> {
  const contacts = await listAllContacts(token);
  for (const c of contacts) {
    if (c.phoneNumbers.some((num) => digitsMatch(num, phoneNumber))) return c.name;
  }
  return null;
}

// The reverse lookup: find a contact's phone number by name, used when the
// user tells gadf to text someone Dero has no WhatsApp history with yet.
export async function searchContactsByName(token: string, name: string): Promise<Array<{ name: string; phoneNumber: string }>> {
  const contacts = await listAllContacts(token);
  const q = name.toLowerCase();
  return contacts.filter((c) => c.name.toLowerCase().includes(q)).map((c) => ({ name: c.name, phoneNumber: c.phoneNumbers[0] }));
}
