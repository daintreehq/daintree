export interface ProbeLimiter {
  /**
   * Runs `task` once a slot is free. Aborting `signal` while the task is still
   * queued drops it from the queue and rejects with the abort reason, so a lookup
   * that gave up behind hung probes leaves nothing behind to run later.
   */
  withSlot<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  queueDepth(): number;
}

export function createProbeLimiter(maxConcurrent: number): ProbeLimiter {
  let activeProbes = 0;
  const probeQueue: Array<() => void> = [];
  return {
    withSlot<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = () => {
          const index = probeQueue.indexOf(run);
          if (index !== -1) probeQueue.splice(index, 1);
          reject(signal?.reason);
        };
        const run = () => {
          signal?.removeEventListener("abort", onAbort);
          activeProbes++;
          new Promise<T>((settle) => settle(task())).then(resolve, reject).finally(() => {
            activeProbes--;
            probeQueue.shift()?.();
          });
        };
        if (activeProbes < maxConcurrent) {
          run();
          return;
        }
        probeQueue.push(run);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    queueDepth: () => probeQueue.length,
  };
}
