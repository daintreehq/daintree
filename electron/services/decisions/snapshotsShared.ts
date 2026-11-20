/**
 * The questions the relay may hold a snapshot of from this store's device,
 * as a JSON object of question id to when it was last shared (epoch ms),
 * recorded before each first share. A settled clear is no proof the relay
 * took it (a refusal settles too), so an entry goes only once the relay can
 * hold nothing of it: the question closed, or its last share is older than
 * the relay keeps any. A restart takes back what a crash or refusal left.
 */
export const SNAPSHOTS_SHARED_META_KEY = "daintree:snapshots-shared";

/** What the store records as shared; anything unreadable is nothing. */
export function sharedRecord(raw: string | null): Map<string, number> {
  const record = new Map<string, number>();
  if (raw === null) return record;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return record;
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof at === "number" && Number.isFinite(at)) record.set(id, at);
    }
  } catch {
    // An unreadable record shares nothing.
  }
  return record;
}
