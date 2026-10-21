import type { CanopyScreenSearchTarget } from "../../../shared/types/ipc/canopy.js";

/** Screens read at once: a search over a full inbox never queues every PTY read together. */
const SEARCH_CONCURRENCY = 4;

/**
 * The runs whose terminal holds every one of their terms, matched here on the
 * machine the terminal runs on: only ids leave, never the screen. Terms are
 * found as written, ignoring case, anywhere in what `read` returns; a run whose
 * screen can't be read matches nothing.
 */
export async function searchScreens(
  targets: readonly CanopyScreenSearchTarget[],
  read: (target: CanopyScreenSearchTarget) => Promise<string | null>
): Promise<string[]> {
  const found = new Array<boolean>(targets.length).fill(false);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const index = next++;
      const target = targets[index]!;
      const terms = target.terms.map((term) => term.toLowerCase()).filter((term) => term !== "");
      if (terms.length === 0) continue;
      const text = await read(target).catch(() => null);
      if (text === null) continue;
      const haystack = text.toLowerCase();
      found[index] = terms.every((term) => haystack.includes(term));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, targets.length) }, () => worker())
  );
  return targets.filter((_, index) => found[index]).map((target) => target.runId);
}
