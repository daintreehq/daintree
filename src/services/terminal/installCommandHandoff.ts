import type { AgentInstallOS } from "@shared/config/agentRegistry";
import { isPtyPanel } from "@shared/types/panel";
import { isShellPromptLine } from "@shared/utils/shellPrompt";
import { formatForTerminalPaste } from "@shared/utils/terminalInputProtocol";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import { terminalClient } from "@/clients";
import { notify } from "@/lib/notify";
import { sanitizeForClipboard } from "@/lib/clipboardSanitize";
import { recheckMissingPrerequisites } from "@/lib/recheckMissingPrerequisites";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { usePanelStore } from "@/store/panelStore";
import { logError, logWarn } from "@/utils/logger";
import { load as loadTerminalService } from "./terminalInstanceServiceAccessor";

/** What a staged install command is meant to make available, so it can be re-checked. */
export type InstallTarget =
  | { kind: "prerequisite"; tool: string }
  | { kind: "agent"; agentId: string };

export interface InstallCommandRequest {
  line: string;
  target: InstallTarget;
  cwd: string;
  worktreeId: string | undefined;
}

/** Long enough for a login shell that loads a version manager; past it, the prompt isn't coming. */
const PROMPT_WAIT_MS = 20_000;
const PROMPT_POLL_MS = 100;
/** A prompt still being drawn (a two-line theme, a late right prompt) isn't one to type into yet. */
const PROMPT_QUIET_MS = 150;
/**
 * A shell with neither bracketed paste nor a prompt shape we know (a custom
 * Windows prompt, an old bash) is taken as ready once its startup output has
 * stopped for this long. The line is never submitted, so typing it a little
 * early can only show it twice, never run it.
 */
const UNRECOGNIZED_PROMPT_QUIET_MS = 2_000;
/** A watch outlives the install only this long; the banner's Re-check is there after. */
const WATCH_MAX_MS = 60 * 60_000;

// A double click opens one terminal per line, not two.
const opening = new Set<string>();
const watches = new Map<string, () => void>();

/**
 * The one line a block's commands are typed as, or null when they can't be
 * one. A POSIX shell runs them in order with `&&`, the same line the banner
 * shows. Windows has no join that holds in every shell a terminal there may
 * run (Windows PowerShell has no `&&`, and `;` would run the next step after a
 * failed one), so a Windows block of several commands offers each on its own.
 */
export function installLineForCommands(
  commands: readonly string[] | undefined,
  os: AgentInstallOS
): string | null {
  if (!commands || commands.length === 0) return null;
  if (commands.length > 1 && os === "windows") return null;
  const line = commands.map((command) => command.trim()).join(" && ");
  return isStageableInstallLine(line) ? line : null;
}

/**
 * Whether a command can be typed at a prompt without running anything: one
 * line, and no control character (a newline or carriage return would submit
 * it, a tab would complete it).
 */
export function isStageableInstallLine(line: string): boolean {
  return line.trim().length > 0 && !/\p{Cc}/u.test(line);
}

function isPanelGone(id: string): boolean {
  const panel = usePanelStore.getState().panelsById[id];
  return !panel || panel.location === "trash" || (isPtyPanel(panel) && panel.spawnStatus === "failed");
}

type TerminalService = Awaited<ReturnType<typeof loadTerminalService>>;
type PromptWait = "ready" | "timeout" | "gone";

function cursorLine(terminal: NonNullable<ReturnType<TerminalService["get"]>>["terminal"]): string {
  const buffer = terminal.buffer.active;
  return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "";
}

/**
 * Waits for the new shell to be reading a line. Bracketed paste is the
 * strongest sign (zsh, bash 5.1+ and fish turn it on as their line editor
 * starts); a prompt shape on the cursor line covers PowerShell, cmd and older
 * bash. Either one counts once output has paused, so a prompt still being
 * drawn isn't typed into.
 */
async function waitForShellPrompt(service: TerminalService, id: string): Promise<PromptWait> {
  const deadline = Date.now() + PROMPT_WAIT_MS;
  try {
    await service.waitForInstance(id, { timeoutMs: PROMPT_WAIT_MS });
  } catch {
    return isPanelGone(id) ? "gone" : "timeout";
  }

  let tracked: ReturnType<TerminalService["get"]> | undefined;
  let subscription: { dispose(): void } | null = null;
  let lastOutputAt = Date.now();
  let sawOutput = false;

  try {
    while (Date.now() < deadline) {
      if (isPanelGone(id)) return "gone";
      const managed = service.get(id);
      if (!managed) return "gone";
      const terminal = managed.terminal;
      if (managed !== tracked) {
        subscription?.dispose();
        tracked = managed;
        subscription = terminal.onWriteParsed(() => {
          lastOutputAt = Date.now();
          sawOutput = true;
        });
        // Output parsed before this subscription (a replay, a pooled shell) moved the cursor.
        const buffer = terminal.buffer.active;
        sawOutput ||= buffer.baseY > 0 || buffer.cursorY > 0 || buffer.cursorX > 0;
      }

      if (terminal.buffer.active.type === "normal") {
        const quietFor = Date.now() - lastOutputAt;
        const atPrompt =
          terminal.modes.bracketedPasteMode || isShellPromptLine(cursorLine(terminal));
        if (atPrompt && quietFor >= PROMPT_QUIET_MS) return "ready";
        if (sawOutput && quietFor >= UNRECOGNIZED_PROMPT_QUIET_MS) return "ready";
      }
      await new Promise((resolve) => window.setTimeout(resolve, PROMPT_POLL_MS));
    }
    return "timeout";
  } finally {
    subscription?.dispose();
  }
}

/** Probes the target afresh; true once it is there. */
export async function recheckInstallTarget(target: InstallTarget): Promise<boolean> {
  if (target.kind === "prerequisite") {
    const stillMissing = await recheckMissingPrerequisites();
    return !stillMissing.some((p) => p.tool === target.tool);
  }
  await useCliAvailabilityStore.getState().refresh(true);
  return isAgentInstalled(useCliAvailabilityStore.getState().availability[target.agentId]);
}

/**
 * Re-checks the target each time the terminal goes from running something to
 * idle, which is when a command the user ran there has finished. Busy and idle
 * are what main observes of the shell's children; nothing reads the terminal's
 * output or its input. A watch ends when the target is there, when the
 * terminal closes or exits (with one last check), or after an hour.
 */
function watchInstallTerminal(id: string, target: InstallTarget): void {
  watches.get(id)?.();

  let disposed = false;
  let busy = false;
  let checking = false;
  let checkAgain = false;
  const cleanups: Array<() => void> = [];

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    if (watches.get(id) === dispose) watches.delete(id);
  };

  const check = async (): Promise<void> => {
    if (disposed) return;
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    try {
      if (await recheckInstallTarget(target)) dispose();
    } catch (error) {
      logWarn("Install re-check after a terminal command failed", { error });
    } finally {
      checking = false;
      if (checkAgain && !disposed) {
        checkAgain = false;
        void check();
      }
    }
  };

  const finish = () => {
    if (disposed) return;
    dispose();
    void recheckInstallTarget(target).catch((error: unknown) =>
      logWarn("Install re-check after its terminal closed failed", { error })
    );
  };

  cleanups.push(
    terminalClient.onActivity((payload) => {
      if (payload.terminalId !== id) return;
      if (payload.status === "working") {
        busy = true;
      } else if (busy) {
        busy = false;
        void check();
      }
    }),
    terminalClient.onExit((exitedId) => {
      if (exitedId === id) finish();
    }),
    usePanelStore.subscribe((state) => {
      const panel = state.panelsById[id];
      if (!panel || panel.location === "trash") finish();
    })
  );
  const timer = window.setTimeout(dispose, WATCH_MAX_MS);
  cleanups.push(() => window.clearTimeout(timer));

  watches.set(id, dispose);
}

function notifyNotTyped(line: string): void {
  notify({
    type: "warning",
    title: "Couldn't type the command",
    message: "The terminal didn't reach a prompt Daintree recognizes. Copy the command and paste it there.",
    context: { eventKind: "host" },
    action: {
      label: "Copy command",
      onClick: () => void navigator.clipboard.writeText(sanitizeForClipboard(line)).catch(() => {}),
    },
  });
}

/**
 * Opens an ordinary terminal and types an install command at its prompt
 * without pressing Enter, so the user reads it (a `curl | bash`, a `sudo`)
 * before running it, and a password prompt is the terminal's own. Then
 * re-checks the tool once the command has run. Resolves the terminal's id, or
 * null when no terminal opened: the panel limit refused it (which says so
 * itself), or the spawn failed (which its pane says).
 */
export async function openInstallCommandInTerminal(
  request: InstallCommandRequest
): Promise<string | null> {
  const line = request.line.trim();
  if (!isStageableInstallLine(line) || opening.has(line)) return null;
  opening.add(line);
  try {
    const id = await usePanelStore.getState().addPanel({
      kind: "terminal",
      cwd: request.cwd,
      worktreeId: request.worktreeId,
      location: "grid",
      focusPolicy: "take",
    });
    if (!id) return null;
    // Watched from the start: if the line can't be typed, the user may still paste it.
    watchInstallTerminal(id, request.target);

    const service = await loadTerminalService();
    const wait = await waitForShellPrompt(service, id);
    if (wait === "gone") return null;
    const managed = service.get(id);
    if (wait === "timeout" || !managed) {
      notifyNotTyped(line);
      return id;
    }
    terminalClient.write(
      id,
      formatForTerminalPaste(line, { bracketedPasteMode: managed.terminal.modes.bracketedPasteMode })
    );
    // A dialog that closed to show this terminal hands focus back on its way out.
    service.focus(id);
    return id;
  } catch (error) {
    logError("Failed to open a terminal for an install command", error);
    notify({
      type: "error",
      title: "Couldn't open a terminal",
      message: "Copy the command and run it in a terminal yourself.",
      context: { eventKind: "host" },
      action: {
        label: "Copy command",
        onClick: () => void navigator.clipboard.writeText(sanitizeForClipboard(line)).catch(() => {}),
      },
    });
    return null;
  } finally {
    opening.delete(line);
  }
}

export const __testing = {
  reset(): void {
    opening.clear();
    for (const dispose of [...watches.values()]) dispose();
    watches.clear();
  },
  watchCount(): number {
    return watches.size;
  },
};
