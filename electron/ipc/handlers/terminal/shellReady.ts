/**
 * Event-driven shell-readiness contract.
 *
 * Instead of waiting a fixed delay before injecting a command into a freshly
 * spawned PTY, observe the shell's actual output: resolve once a prompt has
 * appeared and the stream has been quiet for `quiescenceMs`. This survives
 * slow-booting RC files (oh-my-zsh, p10k, nvm, direnv) and p10k's two-phase
 * instant-prompt → real-prompt render by resetting the quiescence timer on
 * any new data.
 *
 * Hard timeout resolves (does not reject) so the degraded fallback is "inject
 * anyway" rather than hang the caller forever. An early `exit` event also
 * resolves so the caller's `hasTerminal` guard can skip the write cleanly.
 */
import type { EventEmitter } from "events";
import { stripAnsi } from "../../../services/pty/AgentPatternDetector.js";

type PtyClientLike = Pick<EventEmitter, "on" | "off"> & {
  hasTerminal(id: string): boolean;
};

export interface WaitForShellReadyOptions {
  /** Hard ceiling before giving up and resolving anyway. */
  timeoutMs?: number;
  /** Silence window after first prompt match before resolving. */
  quiescenceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_QUIESCENCE_MS = 200;

// End-anchored patterns: a real prompt places the cursor immediately after the
// prompt character. This is stricter than a start-anchored match, so stray RC
// lines like "# sourcing plugin" won't trip detection — the `#` isn't at the
// end of the line. Covers plain prompts ($ # % > ❯), `user@host dir $`-style
// bash/zsh, and oh-my-zsh arrow themes.
const PROMPT_PATTERNS = [
  /[>›❯⟩$#%]\s*$/,
  /[A-Za-z0-9_.-]+@[\w.-]+(?:[^\r\n]*)?\s*[#$%>]\s*$/,
  /[➜➤➟➔❯›]\s+[^\r\n]*$/,
];

function hasPromptCharacter(chunk: string): boolean {
  const clean = stripAnsi(chunk);
  if (clean.length === 0) return false;
  // A single chunk may contain multiple lines separated by \n, \r, or \r\n;
  // we care about the last visible line because that's where the cursor sits.
  const lastBreak = Math.max(clean.lastIndexOf("\n"), clean.lastIndexOf("\r"));
  const lastLine = lastBreak >= 0 ? clean.slice(lastBreak + 1) : clean;
  if (lastLine.length === 0) return false;
  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(lastLine)) return true;
  }
  return false;
}

export function waitForShellReady(
  ptyClient: PtyClientLike,
  terminalId: string,
  options: WaitForShellReadyOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const quiescenceMs = options.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;

  return new Promise<void>((resolve) => {
    let settled = false;
    let quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
    let sawPrompt = false;

    const cleanup = () => {
      ptyClient.off("data", onData);
      ptyClient.off("exit", onExit);
      if (quiescenceTimer !== null) {
        clearTimeout(quiescenceTimer);
        quiescenceTimer = null;
      }
      clearTimeout(hardTimeout);
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onData = (id: string, data: string) => {
      if (id !== terminalId || settled) return;
      if (!sawPrompt) {
        if (hasPromptCharacter(data)) {
          sawPrompt = true;
          quiescenceTimer = setTimeout(settle, quiescenceMs);
        }
        return;
      }
      // Reset quiescence window on any subsequent output — handles p10k's
      // two-phase prompt (instant placeholder, then real prompt once RC
      // finishes).
      if (quiescenceTimer !== null) {
        clearTimeout(quiescenceTimer);
      }
      quiescenceTimer = setTimeout(settle, quiescenceMs);
    };

    const onExit = (id: string) => {
      if (id !== terminalId) return;
      settle();
    };

    const hardTimeout = setTimeout(settle, timeoutMs);

    ptyClient.on("data", onData);
    ptyClient.on("exit", onExit);
  });
}
