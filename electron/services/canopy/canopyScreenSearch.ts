import type { CanopyScreenSearchTarget } from "../../../shared/types/ipc/canopy.js";

/**
 * Screens read at once, across every search in flight: searches typed one on
 * another, from any window or host, queue behind the same few reads rather
 * than each starting its own.
 */
const SEARCH_CONCURRENCY = 4;

let reading = 0;
const waiting: Array<() => void> = [];

async function withReadSlot<T>(read: () => Promise<T>): Promise<T> {
  if (reading >= SEARCH_CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    reading += 1;
  }
  try {
    return await read();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else reading -= 1;
  }
}

/**
 * The runs whose terminal holds every one of their terms, matched here on the
 * machine the terminal runs on: only ids leave, never the screen. Terms are
 * found as written, ignoring case, anywhere in what `read` returns; a run whose
 * screen can't be read matches nothing. A run named twice is read once.
 */
export async function searchScreens(
  targets: readonly CanopyScreenSearchTarget[],
  read: (target: CanopyScreenSearchTarget) => Promise<string | null>
): Promise<string[]> {
  const unique = new Map<string, CanopyScreenSearchTarget>();
  for (const target of targets) {
    const key = `${target.runId}\u0000${target.spawnedAt}`;
    if (!unique.has(key)) unique.set(key, target);
  }
  const found = await Promise.all(
    [...unique.values()].map(async (target) => {
      const terms = target.terms.map((term) => term.toLowerCase()).filter((term) => term !== "");
      if (terms.length === 0) return false;
      const text = await withReadSlot(() => read(target)).catch(() => null);
      if (text === null) return false;
      const haystack = text.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
  );
  return [...unique.values()].filter((_, index) => found[index]).map((target) => target.runId);
}
