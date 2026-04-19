/**
 * Decide whether to start the renderer in parallel with PTY host bootstrap.
 *
 * The default serial path awaits `ptyClient.waitForReady()` before calling
 * `loadRenderer()`, which blocks first paint behind the PTY handshake (~70–150ms
 * cold). When `DAINTREE_EARLY_RENDERER=1` is set, the renderer load is hoisted
 * ahead of the workspace/PTY init block. The smoke test path is excluded so its
 * deterministic readiness checks keep working unmodified.
 */
export function shouldEnableEarlyRenderer(opts: {
  isSmokeTest: boolean;
  env: NodeJS.ProcessEnv;
}): boolean {
  return !opts.isSmokeTest && opts.env.DAINTREE_EARLY_RENDERER === "1";
}
