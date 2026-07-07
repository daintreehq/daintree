/**
 * Max held ingest bytes a resize may force-flush into xterm synchronously.
 * `terminal.resize()` parses xterm's ENTIRE write buffer in one unyielding
 * main-thread task before reflowing (`CoreTerminal.resize` →
 * `WriteBuffer.flushSync`), so the pre-resize `flushForTerminal` — which
 * deliberately bypasses the ingest in-flight watermark — must stay bounded. A
 * project view hidden for minutes accumulates its agents' entire output in
 * the ingest queue (hidden-page timer throttling stalls xterm's parse pump
 * while MessagePort chunks keep arriving), and the reveal-time
 * ResizeObserver resize then detonated that backlog as a 45-60s renderer
 * lockup (2026-07-06: UI dead, MCP dispatches through the active view timing
 * out). Past this budget the backlog skips the flush and drains watermarked
 * at the new grid instead — the same wrap outcome as output arriving just
 * after a resize, without the synchronous parse; the PTY SIGWINCH repaint
 * corrects any TUI framing either way.
 *
 * Lives in this leaf module (no renderer imports) so the perf harness
 * (PERF-112, `scripts/perf/lib/reflowFixture.ts`) can size its backlog arms
 * against the real constant without dragging `@/clients` into the tsx
 * runner. PERF-112 fails its budget if this gate is bypassed or loosened.
 */
export const RESIZE_FLUSH_SYNC_BUDGET_BYTES = 1024 * 1024;
