let nextHandle = -1;

/**
 * Negative and never reused within a process, so a remote handle can't collide
 * with a `WebContents` id or with an endpoint that has since closed. Shared by
 * the Host's remote endpoints and the Shell's Canopy viewers, which is why it
 * lives outside both.
 */
export function allocateRemoteHandle(): number {
  const handle = nextHandle;
  nextHandle = handle <= -Number.MAX_SAFE_INTEGER ? -1 : handle - 1;
  return handle;
}
