import { isPtyPanel } from "@shared/types/panel";
import { isShellPromptLine } from "@shared/utils/shellPrompt";
import { formatForTerminalPaste } from "@shared/utils/terminalInputProtocol";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import { terminalClient } from "@/clients";
import { notify } from "@/lib/notify";
import { sanitizeForClipboard } from "@/lib/clipboardSanitize";
import { copyWithToast } from "@/lib/copyWithToast";
import { recheckPrerequisite } from "@/lib/recheckMissingPrerequisites";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { usePanelStore } from "@/store/panelStore";
import { logError, logWarn } from "@/utils/logger";
import { load as loadTerminalService } from "./terminalInstanceServiceAccessor";
import { isStageableInstallLine, type InstallTarget } from "./installCommandLine";

export type { InstallTarget };

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
 * Busy and idle miss an install that finishes between two process-tree polls,
 * and a shell with a resident child (a prompt theme's git daemon) never looks
 * idle, so the target is also probed this often while an install is likely
 * still in hand.
 */
const RECHECK_EVERY_MS = 20_000;
const RECHECK_FOR_MS = 10 * 60_000;
/** A watch outlives the install only this long; the banner's Re-check is there after. */
const WATCH_MAX_MS = 60 * 60_000;

// A double click opens one terminal per line, not two.
const opening = new Set<string>();
const watches = new Map<string, () => void>();

function isPanelGone(id: string): boolean {
  const panel = usePanelStore.getState().panelsById[id];
  return (
    !panel || panel.location === "trash" || (isPtyPanel(panel) && panel.spawnStatus === "failed")
  );
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
 * drawn isn't typed into. Silence alone never counts: a startup script asking
 * for an ssh passphrase or a sudo password is silent too, and the line would
 * land in that prompt instead.
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
        });
      }

      if (
        terminal.buffer.active.type === "normal" &&
        Date.now() - lastOutputAt >= PROMPT_QUIET_MS &&
        (terminal.modes.bracketedPasteMode || isShellPromptLine(cursorLine(terminal)))
      ) {
        return "ready";
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
  if (target.kind === "prerequisite") return recheckPrerequisite(target.tool);
  await useCliAvailabilityStore.getState().refresh(true);
  return isAgentInstalled(useCliAvailabilityStore.getState().availability[target.agentId]);
}

/**
 * Re-checks the target each time the terminal goes from running something to
 * idle, which is when a command the user ran there has finished, and every so
 * often for the first minutes besides. Busy and idle are what main observes of
 * the shell's children; nothing reads the terminal's output or its input. A
 * watch ends when the target is there, when the terminal closes, exits or fails
 * to spawn (with one last check), or after an hour.
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
    usePanelStore.subscribe(() => {
      if (isPanelGone(id)) finish();
    })
  );
  const timer = window.setTimeout(dispose, WATCH_MAX_MS);
  cleanups.push(() => window.clearTimeout(timer));

  const startedAt = Date.now();
  let recheckTimer = 0;
  const scheduleRecheck = (): void => {
    if (disposed || Date.now() - startedAt >= RECHECK_FOR_MS) return;
    recheckTimer = window.setTimeout(() => void check().finally(scheduleRecheck), RECHECK_EVERY_MS);
  };
  cleanups.push(() => window.clearTimeout(recheckTimer));
  scheduleRecheck();

  watches.set(id, dispose);
}

function notifyNotTyped(line: string): void {
  notify({
    type: "warning",
    title: "Couldn't type the command",
    message:
      "The terminal didn't reach a prompt Daintree recognizes. Copy the command and paste it there.",
    context: { eventKind: "host" },
    action: {
      label: "Copy command",
      onClick: () => copyWithToast("Command", sanitizeForClipboard(line)),
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
      formatForTerminalPaste(line, {
        bracketedPasteMode: managed.terminal.modes.bracketedPasteMode,
      })
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
        onClick: () => copyWithToast("Command", sanitizeForClipboard(line)),
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
