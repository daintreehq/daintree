import { ManagedTerminal } from "./types";
import { getAgentConfig } from "@/config/agents";

// DEC private mode codes that switch to alternate screen buffer
// Mode 47: Switch to alternate screen (older)
// Mode 1047: Use alternate screen buffer
// Mode 1049: Save cursor + switch to alternate screen buffer (most common)
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

export class TerminalParserHandler {
  private managed: ManagedTerminal;
  private disposables: Array<{ dispose: () => void }> = [];
  private onBufferExit?: () => void;

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

  constructor(managed: ManagedTerminal, onBufferExit?: () => void) {
    this.managed = managed;
    this.onBufferExit = onBufferExit;
    this.attachHandlers();
  }

  private getAgentCapabilities(): {
    blockAltScreen: boolean;
    blockMouseReporting: boolean;
    blockScrollRegion: boolean;
    blockClearScreen: boolean;
    blockCursorToTop: boolean;
  } {
    if (this.managed.kind !== "agent") {
      return {
        blockAltScreen: false,
        blockMouseReporting: false,
        blockScrollRegion: false,
        blockClearScreen: false,
        blockCursorToTop: false,
      };
    }

    const effectiveAgentId = this.managed.agentId ?? this.managed.type;
    const config = getAgentConfig(effectiveAgentId);

    return {
      blockAltScreen: config?.capabilities?.blockAltScreen ?? false,
      blockMouseReporting: config?.capabilities?.blockMouseReporting ?? false,
      blockScrollRegion: config?.capabilities?.blockScrollRegion ?? false,
      blockClearScreen: config?.capabilities?.blockClearScreen ?? false,
      blockCursorToTop: config?.capabilities?.blockCursorToTop ?? false,
    };
  }

  private attachHandlers(): void {
    const { terminal } = this.managed;

    if (!terminal.parser || !terminal.parser.registerCsiHandler) {
      return; // Graceful degradation if proposed API missing
    }

    const capabilities = this.getAgentCapabilities();

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

    // Block mouse reporting mode toggles (enables programs to capture mouse events).
    // We block this for agent terminals to avoid surprising interactions inside the app.
    if (capabilities.blockMouseReporting) {
      const mouseModeParams = new Set([1000, 1002, 1003, 1005, 1006, 1015]);

      const decsetMouseHandler = terminal.parser.registerCsiHandler(
        { prefix: "?", final: "h" },
        (params) => {
          if (!this.shouldBlock()) return false;
          const p = this.normalizeCsiParams(params);
          if (!p.some((v) => mouseModeParams.has(v))) return false;
          return true;
        }
      );
      this.disposables.push(decsetMouseHandler);

      const decrstMouseHandler = terminal.parser.registerCsiHandler(
        { prefix: "?", final: "l" },
        (params) => {
          if (!this.shouldBlock()) return false;
          const p = this.normalizeCsiParams(params);
          if (!p.some((v) => mouseModeParams.has(v))) return false;
          return true;
        }
      );
      this.disposables.push(decrstMouseHandler);
    }
  }

  private shouldBlock(): boolean {
    // Block for all agent terminals by default
    return this.managed.kind === "agent";
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
