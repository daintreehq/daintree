import { ManagedTerminal } from "./types";
import { getAgentConfig } from "@/config/agents";

// DEC private mode codes that switch to alternate screen buffer
// Mode 47: Switch to alternate screen (older)
// Mode 1047: Use alternate screen buffer
// Mode 1049: Save cursor + switch to alternate screen buffer (most common)
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

// Private-use OSC identifier carrying the PTY data-loss signal. Chosen from
// the high private range (57300+) to avoid clashing with emulator OSC numbers
// (iTerm2 1337, rxvt 777, WezTerm 1000-range) or our own OSC 11/52 handlers.
// Wire format: ESC ] 57301 ; <droppedBytes> ; <reasonCode> BEL
const OSC_DATA_LOSS = 57301;

export class TerminalParserHandler {
  private managed: ManagedTerminal;
  private disposables: Array<{ dispose: () => void }> = [];
  private onBufferExit?: () => void;
  private onDataLoss?: (droppedBytes: number) => void;

  private normalizeCsiParams(params: Array<number | number[]> | undefined): number[] {
    if (!params) return [];
    const flat: number[] = [];
    for (const p of params) {
      if (Array.isArray(p)) {
        for (const v of p) flat.push(v);
      } else {
        flat.push(p);
      }
    }
    return flat;
  }

  constructor(
    managed: ManagedTerminal,
    onBufferExit?: () => void,
    onDataLoss?: (droppedBytes: number) => void
  ) {
    this.managed = managed;
    this.onBufferExit = onBufferExit;
    this.onDataLoss = onDataLoss;
    this.attachHandlers();
  }

  private getAgentCapabilities(): {
    blockAltScreen: boolean;
    blockMouseReporting: boolean;
  } {
    if (!this.managed.runtimeAgentId) {
      return {
        blockAltScreen: false,
        blockMouseReporting: false,
      };
    }

    const effectiveAgentId = this.managed.runtimeAgentId;
    const config = getAgentConfig(effectiveAgentId);

    return {
      blockAltScreen: config?.capabilities?.blockAltScreen ?? false,
      blockMouseReporting: config?.capabilities?.blockMouseReporting ?? false,
    };
  }

  private attachHandlers(): void {
    const { terminal } = this.managed;

    if (
      !terminal.parser ||
      !terminal.parser.registerCsiHandler ||
      !terminal.parser.registerOscHandler
    ) {
      return; // Graceful degradation if proposed API missing
    }

    // Block OSC 52 clipboard write sequences (defense-in-depth against pastejacking).
    // Unconditional — all terminal kinds must block this attack vector.
    const osc52Handler = terminal.parser.registerOscHandler(52, () => true);
    this.disposables.push(osc52Handler);

    // PTY data-loss marker. The pty-host drops bytes (drop-don't-block) during
    // heavy-output bursts and signals it through this private-use OSC instead
    // of a raw ANSI write, keeping the wire format free of presentation. xterm
    // strips the identifier + first semicolon, so `data` is "<bytes>;<reason>".
    // Always consume (return true) so a malformed payload never leaks into the
    // buffer. The callback is fired synchronously; the caller is responsible
    // for deferring any terminal.write to avoid write-during-parse reentrancy.
    const dataLossHandler = terminal.parser.registerOscHandler(OSC_DATA_LOSS, (data) => {
      const sepIdx = data.indexOf(";");
      if (sepIdx === -1) return true;
      const bytesField = data.slice(0, sepIdx);
      // Strict decimal-only: reject "", "0x10", "1e3", "+1", " ", which
      // Number() would otherwise coerce. Defensive against a crafted stream
      // deliberately targeting this private-use OSC.
      if (!/^\d+$/.test(bytesField)) return true;
      const droppedBytes = Number(bytesField);
      if (!Number.isSafeInteger(droppedBytes)) return true;
      this.onDataLoss?.(droppedBytes);
      return true;
    });
    this.disposables.push(dataLossHandler);

    // Track alternate screen buffer exit via DEC private mode sequences.
    // Note: Buffer state (isAltBuffer) is primarily tracked via xterm.js's
    // onBufferChange event in TerminalInstanceService. This handler only
    // observes the exit sequence to trigger deferred resize application.
    // CSI ? Pm l = DECRST (disable mode)
    const altScreenResetHandler = terminal.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        const p = this.normalizeCsiParams(params);
        if (p.some((v) => ALT_SCREEN_MODES.has(v))) {
          // Apply deferred resize when leaving alternate buffer.
          // If dimensions changed while in alt buffer, the normal buffer needs to catch up.
          if (this.onBufferExit) {
            this.onBufferExit();
          }
        }
        return false; // Don't block, just observe
      }
    );
    this.disposables.push(altScreenResetHandler);

    // Block alternate screen buffer activation if the current runtime agent
    // config asks for it. Register unconditionally so a plain terminal can
    // become an agent terminal without recreating parser handlers.
    const altScreenSetHandler = terminal.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        if (!this.shouldBlock()) return false;
        if (!this.getAgentCapabilities().blockAltScreen) return false;
        const p = this.normalizeCsiParams(params);
        return p.some((v) => ALT_SCREEN_MODES.has(v));
      }
    );
    this.disposables.push(altScreenSetHandler);

    // Block mouse reporting mode toggles (enables programs to capture mouse events).
    // We block this for agent terminals to avoid surprising interactions inside the app.
    const mouseModeParams = new Set([1000, 1002, 1003, 1005, 1006, 1015]);
    const decsetMouseHandler = terminal.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        if (!this.shouldBlock()) return false;
        if (!this.getAgentCapabilities().blockMouseReporting) return false;
        const p = this.normalizeCsiParams(params);
        if (!p.some((v) => mouseModeParams.has(v))) return false;
        return true;
      }
    );
    this.disposables.push(decsetMouseHandler);
  }

  private shouldBlock(): boolean {
    // Runtime identity, not launch intent, decides whether agent parser
    // protections are active.
    return Boolean(this.managed.runtimeAgentId);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
