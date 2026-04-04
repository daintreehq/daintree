/**
 * Debounce utility with cancel and flush methods for persistence batching.
 * Collects rapid calls and executes only the final state after delay.
 */
export function debounce<Args extends unknown[]>(
  func: (...args: Args) => void | Promise<void>,
  wait: number
): ((...args: Args) => void) & { cancel: () => void; flush: () => Promise<void> } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Args | null = null;
  let runningPromise: Promise<void> | null = null;

  const debounced = (...args: Args) => {
    lastArgs = args;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      if (lastArgs !== null) {
        const args = lastArgs;
        timeoutId = null;
        lastArgs = null;
        const p = Promise.resolve()
          .then(() => func(...args))
          .catch((err) => console.error("Debounce execution failed:", err))
          .finally(() => {
            if (runningPromise === p) {
              runningPromise = null;
            }
          });
        runningPromise = p;
      }
    }, wait);
  };

  debounced.cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
      lastArgs = null;
    }
  };

  debounced.flush = async (): Promise<void> => {
    if (timeoutId !== null && lastArgs !== null) {
      clearTimeout(timeoutId);
      const args = lastArgs;
      timeoutId = null;
      lastArgs = null;
      const p = Promise.resolve()
        .then(() => func(...args))
        .catch((err) => console.error("Debounce flush failed:", err))
        .finally(() => {
          if (runningPromise === p) {
            runningPromise = null;
          }
        });
      runningPromise = p;
      await p;
    } else if (runningPromise) {
      await runningPromise;
    }
  };

  return debounced;
}
