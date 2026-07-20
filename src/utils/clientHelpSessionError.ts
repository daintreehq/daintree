/**
 * Renderer-side decoder for `HelpSessionError` codes thrown by help-session
 * provisioning in the main process. Electron's contextBridge strips ALL
 * custom Error properties (including `code`) at the preload→renderer realm
 * boundary, so the preload's `_reconstructHelpSessionError` encodes the code
 * into a `[HelpSessionError|<code>] message` prefix — the only reliable
 * carrier — which this guard decodes. Same pattern as `clientAppError.ts`.
 */

// Group 1 is the HelpSessionErrorCode (uppercase identifier). Group 2 is the
// original human-readable message that follows the closing `]`.
const ENCODED_HELP_SESSION_ERROR_PATTERN = /^\[HelpSessionError\|([A-Z_]+)\] (.*)$/s;

/**
 * Returns the `HelpSessionErrorCode` carried by `e`, or undefined. Decodes
 * the preload's encoded prefix (and, as a side effect, restores `name` and
 * `code` and cleans `message` so later formatting doesn't show the prefix);
 * falls back to duck-typing a string `code` property for errors that never
 * crossed the contextBridge (same-realm throws, tests).
 */
export function extractHelpSessionErrorCode(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return undefined;
  if (e instanceof Error) {
    const match = ENCODED_HELP_SESSION_ERROR_PATTERN.exec(e.message);
    if (match) {
      const [, code, originalMessage] = match;
      const target = e as Error & { code?: string };
      target.name = "HelpSessionError";
      target.code = code;
      e.message = originalMessage ?? e.message;
      return code;
    }
  }
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
