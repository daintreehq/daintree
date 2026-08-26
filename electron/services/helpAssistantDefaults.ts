import { app } from "electron";

/**
 * Debug logging is ON in development and OFF in a packaged build.
 *
 * The trace is the only way to see what the engine actually did — the model requests,
 * the MCP wire calls, the full tool payloads — and a development build is exactly where
 * someone is trying to work out why a turn went wrong. Off by default there meant every
 * such investigation began with "turn the switch on and reproduce it", which throws away
 * the run you were looking at.
 *
 * Still off when packaged, and that half is not a default to soften: the file holds the
 * conversation, terminal output and file excerpts (redaction removes credential SHAPES,
 * not content), so it is an owner-only artifact somebody opts into rather than something
 * an install starts writing on its own.
 *
 * The ONLY answer, not a default with a preference over it. There was a settings switch
 * behind this; it read only on the built-in engine, so it left the other two assistant
 * backends with a control that did nothing, and it went when the engine's own settings
 * left Daintree. A stale stored value is deliberately ignored — see the test in
 * `HelpSessionService.test.ts`.
 *
 * ## Why this is a function, and why it swallows
 *
 * Both importers are eager modules, so reading `app.isPackaged` at module scope would
 * run at import time — and a unit test that replaces the `electron` module with only the
 * members it exercises (`vi.mock("electron", () => ({ ipcMain }))`, which several do)
 * leaves `app` undefined and takes the whole suite down at import with a TypeError, no
 * test having run. Asking lazily, and treating "cannot tell" as OFF, keeps that failure
 * out of the import path and answers conservatively: a build whose packaging is unknown
 * does not start writing conversation content to disk.
 */
export function defaultDebugLogging(): boolean {
  try {
    return !app.isPackaged;
  } catch {
    return false;
  }
}
