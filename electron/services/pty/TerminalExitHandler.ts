import type * as pty from "node-pty";
import { events } from "../events.js";
import type { ExitReason, TerminalInfo } from "./types.js";
import type { TerminalExitObservers, TerminalExitArgs } from "./TerminalExitObservers.js";
import type { IdentityWatcher } from "./IdentityWatcher.js";
import type { TerminalForensicsBuffer } from "./TerminalForensicsBuffer.js";
import type { TerminalProcessLifecycle } from "./TerminalProcessLifecycle.js";
import type { SessionSnapshotter } from "./SessionSnapshotter.js";
import { computeDefaultTitle } from "./terminalTitle.js";

export interface TerminalExitHandlerHost {
  readonly id: string;
  readonly terminalInfo: TerminalInfo;
  readonly exitObservers: TerminalExitObservers;
  readonly identityWatcher: IdentityWatcher;
  readonly forensicsBuffer: TerminalForensicsBuffer;
  readonly lifecycle: TerminalProcessLifecycle;
  readonly sessionSnapshotter: SessionSnapshotter;
  lastDetectedProcessIconId: string | undefined;
  teardown(reason: ExitReason): boolean;
  emitTerminalExited(args: TerminalExitArgs): void;
  shouldPreserveOnExit(exitCode: number): boolean;
  snapshotAndDisposePreserved(): void;
  disposeHeadless(): void;
  onExit(id: string, exitCode: number, signal?: number): void;
}

export class TerminalExitHandler {
  constructor(private readonly host: TerminalExitHandlerHost) {}

  handleExit(ptyProcess: pty.IPty, exitCode: number | undefined, signal: number | undefined): void {
    const terminal = this.host.terminalInfo;
    if (terminal.ptyProcess !== ptyProcess) {
      return;
    }

    // dispose() may have already emitted terminal:exited and notified
    // the registry via callbacks.onExit. A late OS-delivered exit must
    // not double-fire either path — both downstream subscribers and
    // PtyManager are not idempotent.
    if (this.host.exitObservers.hasEmitted) {
      return;
    }

    this.host.identityWatcher.stop();

    // Capture forensic tail before disposeHeadless() clears the buffer.
    // The terminal:exited subscriber reads this via the payload — once
    // `disposeHeadless` runs, `forensicsBuffer.getRecentOutput()` is gone.
    const recentOutput = this.host.forensicsBuffer.getRecentOutput();

    // teardown() returns false when kill() / dispose() got here first,
    // in which case the prior reason is preserved in lifecycle state. The
    // event payload still carries the actual exit code from the PTY,
    // so subscribers see e.g. `reason: "kill"` with `code: 0`.
    const teardownReason = this.host.lifecycle.getExitReason() ?? "natural";
    this.host.teardown("natural");
    this.host.sessionSnapshotter.dispose();

    const reasonForEvent = this.host.lifecycle.getExitReason() ?? teardownReason;

    const previousAgent = terminal.detectedAgentId;
    const hadDetectedIdentity =
      previousAgent !== undefined ||
      terminal.detectedProcessIconId !== undefined ||
      this.host.lastDetectedProcessIconId !== undefined;
    if (hadDetectedIdentity && !terminal.wasKilled) {
      terminal.detectedAgentId = undefined;
      terminal.detectedProcessIconId = undefined;
      this.host.lastDetectedProcessIconId = undefined;
      if (previousAgent) {
        terminal.analysisEnabled = false;
      }
      const nextTitle = computeDefaultTitle(terminal);
      if (previousAgent && (terminal.titleMode ?? "default") === "default") {
        terminal.title = nextTitle;
      }
      events.emit("agent:exited", {
        terminalId: this.host.id,
        agentType: previousAgent,
        defaultTitle: previousAgent ? nextTitle : undefined,
        timestamp: Date.now(),
        ...(previousAgent ? { exitKind: "terminal" as const } : {}),
      });
    }

    this.host.onExit(this.host.id, exitCode ?? 0, signal ?? undefined);

    this.host.emitTerminalExited({
      code: exitCode ?? 0,
      signal,
      reason: reasonForEvent,
      recentOutput,
    });

    // Persist exit metadata on every natural exit — not just the preserve
    // path. The exit code is the authoritative pass/fail signal an MCP
    // supervisor reads, and gating it on preserve-on-exit left ephemeral
    // terminals with no recorded outcome (#10638). A user kill is not an
    // outcome, so it is still excluded — that path emits agent:killed, not a
    // completion. The write sits inside the ptyProcess identity guard and
    // hasEmitted dedup above, so a stale exit from a respawned PTY cannot
    // overwrite the live session (lesson #5948).
    if (!terminal.wasKilled) {
      terminal.exitCode = exitCode ?? 0;
      terminal.exitSignal = signal;
      terminal.isExited = true;
    }

    const preserve = this.host.shouldPreserveOnExit(exitCode ?? 0);
    if (preserve) {
      this.host.lifecycle.setExited({ code: exitCode ?? 0, signal, reason: reasonForEvent });
      this.host.snapshotAndDisposePreserved();
      return;
    }

    this.host.disposeHeadless();
    this.host.lifecycle.setDisposed(reasonForEvent);
  }
}
