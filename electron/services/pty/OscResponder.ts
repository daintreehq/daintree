// OSC 10/11 "?" queries terminated by BEL (\x07) or ST (\x1b\\).
// Trigger and strip must use the same terminator-requiring pattern: if we
// responded on an unterminated fragment but stripped only terminated ones,
// a split chunk would leak the fragment to the renderer and double-respond
// once xterm.js re-assembles the sequence.
// eslint-disable-next-line no-control-regex
const OSC_10_QUERY_RE = /\x1b\]10;\?(?:\x07|\x1b\\)/;
// eslint-disable-next-line no-control-regex
const OSC_11_QUERY_RE = /\x1b\]11;\?(?:\x07|\x1b\\)/;
// eslint-disable-next-line no-control-regex
const OSC_10_QUERY_STRIP_RE = /\x1b\]10;\?(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const OSC_11_QUERY_STRIP_RE = /\x1b\]11;\?(?:\x07|\x1b\\)/g;

/**
 * Respond to OSC 10/11 (foreground/background color) queries on behalf of an
 * agent-owned PTY. termenv-based TUIs (Bubble Tea, OpenCode, Gemini CLI) block
 * for 5 seconds per query without a reply. The renderer's xterm.js also replies
 * by default, so to keep exactly one responder active we strip queries whose
 * backend response succeeded from the data forwarded to the renderer. If a
 * write fails, the query is left intact so the renderer can satisfy it and the
 * TUI does not hang.
 *
 * Caller owns the gate (whether the terminal is agent-live) and any cheap
 * fast-path heuristic. Write errors are swallowed silently — matching the
 * `headlessResponder` pattern — because the strip-on-success invariant
 * preserves the fail-open behavior.
 */
export function handleOscColorQueries(
  data: string,
  writeToPty: (response: string) => void
): string {
  const has10 = OSC_10_QUERY_RE.test(data);
  const has11 = OSC_11_QUERY_RE.test(data);
  let handled10 = false;
  let handled11 = false;
  if (has10) {
    try {
      writeToPty("\x1b]10;rgb:cccc/cccc/cccc\x1b\\");
      handled10 = true;
    } catch {
      // PTY may already be dead; leave the query intact for the renderer.
    }
  }
  if (has11) {
    try {
      writeToPty("\x1b]11;rgb:0000/0000/0000\x1b\\");
      handled11 = true;
    } catch {
      // PTY may already be dead; leave the query intact for the renderer.
    }
  }
  let rendererData = data;
  if (handled10) rendererData = rendererData.replace(OSC_10_QUERY_STRIP_RE, "");
  if (handled11) rendererData = rendererData.replace(OSC_11_QUERY_STRIP_RE, "");
  return rendererData;
}
