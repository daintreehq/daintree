/**
 * An `onError` that settles a queued request once the commit that caught the
 * error is over (#17204). Settling moves the queue on, which resets the
 * boundary for the next request; done inside `componentDidCatch`, a queue
 * behind a dialog that keeps failing chains one nested update per request and
 * trips React's update-depth limit. The settle step must name the request the
 * failed render showed, since another may be in front by the time it runs.
 */
export function afterCatch(settle: () => void): () => void {
  return () => queueMicrotask(settle);
}
