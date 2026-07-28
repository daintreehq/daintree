/**
 * Deterministic djb2 string hash. Stable across processes and runs, so it can
 * back "always pick the same thing for the same name" selections (avatar
 * colors, suggested project emoji) without persisting the choice.
 *
 * Returns a signed 32-bit integer — callers index with
 * `Math.abs(djb2(key)) % list.length`.
 */
export function djb2(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return hash;
}
