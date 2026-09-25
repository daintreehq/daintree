/**
 * Wait for an observable condition instead of sleeping: polls on a short
 * timer and fails with `label` once `timeoutMs` passes.
 */
export async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
