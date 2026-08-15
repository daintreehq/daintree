/**
 * Reference-counted eviction leases for renderer views with an MCP operation in
 * flight (#11790).
 *
 * A workspace-bound external session dispatches into a *background* view — that
 * is the point of the binding. Memory-pressure eviction destroys the WebContents
 * (`cleanupEntry`), so a pass landing mid-dispatch strands the in-flight request
 * until its 30s deadline and leaves every later call failing
 * `SESSION_BINDING_GONE`.
 *
 * A lease marks "this exact view is answering an MCP request right now" so the
 * eviction pass can skip it, alongside the paint-gate and cold-switch
 * exclusions. Deliberately NOT the unconditional floor a live assistant backend
 * gets (#11157): that floor exists because eviction there kills a PTY process
 * tree, and the argument does not transfer. A lease is bounded by construction —
 * every holder is a pending bridge request, and those are capped by
 * `MCP_MANIFEST_REQUEST_TIMEOUT_MS` / `MCP_DISPATCH_TIMEOUT_MS` — so enough
 * concurrent bound sessions can never defeat the pressure policy the way a
 * permanent floor would. A bound session that goes quiet holds nothing.
 *
 * Keyed by `webContentsId`, not workspace id: the id is what eviction has in
 * hand for each candidate entry, and it is the exact view the request is
 * awaiting. A workspace whose view was replaced by a cold start gets a new id,
 * so a stale lease can never protect the wrong renderer.
 *
 * Leaf module — no imports, so both `electron/services/mcp-server/` (writer) and
 * `electron/window/` (reader, via the injected activity callback) can reach it
 * without a cycle or an eager-graph cost.
 */
export class WorkspaceViewLeaseRegistry {
  private readonly counts = new Map<number, number>();

  /**
   * Take a lease on `webContentsId` and return its release.
   *
   * The release is idempotent: bridge requests settle through several paths
   * (response, timeout, WebContents destruction, a synchronous `send()` throw)
   * and more than one can run for the same request, so a double release must
   * not decrement another caller's reference. A leaked lease would quietly
   * recreate the permanent floor this design exists to avoid, so the caller
   * must wire the release into every settle path — not just the happy one.
   */
  acquire(webContentsId: number): () => void {
    this.counts.set(webContentsId, (this.counts.get(webContentsId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.counts.get(webContentsId) ?? 0) - 1;
      if (remaining > 0) {
        this.counts.set(webContentsId, remaining);
      } else {
        this.counts.delete(webContentsId);
      }
    };
  }

  /** Whether an MCP request is currently awaiting this exact view. */
  has(webContentsId: number): boolean {
    return (this.counts.get(webContentsId) ?? 0) > 0;
  }

  /**
   * Drop every lease. Called when the MCP server stops: `HttpLifecycle.stop()`
   * rejects the pending requests that own these leases, so keeping the counts
   * would pin views for renderers that will never answer.
   */
  clear(): void {
    this.counts.clear();
  }
}
