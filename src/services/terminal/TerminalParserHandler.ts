import { ManagedTerminal } from "./types";
import { getAgentConfig } from "@/config/agents";

export class TerminalParserHandler {
  private managed: ManagedTerminal;
  private disposables: Array<{ dispose: () => void }> = [];
  private allowResets = false;

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

  constructor(managed: ManagedTerminal) {
    this.managed = managed;
    this.attachHandlers();
  }

  setAllowResets(allow: boolean): void {
    this.allowResets = allow;
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

    const defaultStableLogMode = effectiveAgentId !== "codex";

    return {
      blockAltScreen: config?.capabilities?.blockAltScreen ?? true,
      blockMouseReporting: config?.capabilities?.blockMouseReporting ?? true,
      blockScrollRegion: config?.capabilities?.blockScrollRegion ?? defaultStableLogMode,
      blockClearScreen: config?.capabilities?.blockClearScreen ?? defaultStableLogMode,
      blockCursorToTop: config?.capabilities?.blockCursorToTop ?? defaultStableLogMode,
    };
  }

  private attachHandlers(): void {
    const { terminal } = this.managed;

    if (!terminal.parser || !terminal.parser.registerEscHandler) {
      return; // Graceful degradation if proposed API missing
    }

    const capabilities = this.getAgentCapabilities();

    // Block RIS (Reset Initial State) - ESC c
    const risHandler = terminal.parser.registerEscHandler({ final: "c" }, () => {
      if (this.allowResets) return false;
      if (!this.shouldBlock()) return false;

      if (process.env.NODE_ENV === "development") {
        console.warn(
          `[TerminalParser] Blocked RIS (ESC c) for agent terminal ${this.managed.agentId || "unknown"}`
        );
      }
      return true; // Swallow the sequence
    });
    this.disposables.push(risHandler);

    // Block DECSTR (Soft Terminal Reset) - CSI ! p
    const decstrHandler = terminal.parser.registerCsiHandler(
      { intermediates: "!", final: "p" },
      () => {
        if (this.allowResets) return false;
        if (!this.shouldBlock()) return false;

        if (process.env.NODE_ENV === "development") {
          console.warn(
            `[TerminalParser] Blocked DECSTR (CSI ! p) for agent terminal ${this.managed.agentId || "unknown"}`
          );
        }
        return true; // Swallow the sequence
      }
    );
    this.disposables.push(decstrHandler);

    // Block DECSTBM (CSI ... r) - Set Scroll Region
    // Agent CLIs often use scroll regions for full-screen UIs; we treat output as a stable log.
    if (capabilities.blockScrollRegion) {
      const decstbmHandler = terminal.parser.registerCsiHandler({ final: "r" }, () => {
        if (!this.shouldBlock()) return false;
        return true;
      });
      this.disposables.push(decstbmHandler);
    }

    // Block ED (CSI ... J) - Erase in Display (clear screen / scrollback).
    // Allow partial clears (0/1) but block full clears (2/3) that nuke scrollback.
    if (capabilities.blockClearScreen) {
      const edHandler = terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
        if (!this.shouldBlock()) return false;
        const p = this.normalizeCsiParams(params);
        if (p.length === 0) return false;
        return p.some((v) => v === 2 || v === 3);
      });
      this.disposables.push(edHandler);
    }

    // Block cursor moves to the top row (CUP/HVP + VPA) which cause viewport jumps in "log" mode.
    if (capabilities.blockCursorToTop) {
      const shouldBlockRow = (row: number | undefined): boolean => {
        // Default is 1 if omitted; treat 0 as 1.
        if (row === undefined) return true;
        return row === 0 || row === 1;
      };

      const cupHandler = terminal.parser.registerCsiHandler({ final: "H" }, (params) => {
        if (!this.shouldBlock()) return false;
        const p = this.normalizeCsiParams(params);
        const row = p[0];
        return shouldBlockRow(row);
      });
      this.disposables.push(cupHandler);

      const hvpHandler = terminal.parser.registerCsiHandler({ final: "f" }, (params) => {
        if (!this.shouldBlock()) return false;
        const p = this.normalizeCsiParams(params);
        const row = p[0];
        return shouldBlockRow(row);
      });
      this.disposables.push(hvpHandler);

      const vpaHandler = terminal.parser.registerCsiHandler({ final: "d" }, (params) => {
        if (!this.shouldBlock()) return false;
        const p = this.normalizeCsiParams(params);
        const row = p[0];
        return shouldBlockRow(row);
      });
      this.disposables.push(vpaHandler);
    }

    // Block DEC private mode toggles that cause full-screen "alternate screen" behavior.
    // This is commonly used by TUIs; we block it for agent terminals to keep output stable and
    // prevent sudden screen jumps (also keeps the header/banner visible in scrollback).
    if (capabilities.blockAltScreen) {
      const altScreenParams = new Set([47, 1047, 1049]);

      const decsetPrivateHandler = terminal.parser.registerCsiHandler(
        { prefix: "?", final: "h" },
        (params) => {
          if (!this.shouldBlock()) return false;
          const p = this.normalizeCsiParams(params);
          if (!p.some((v) => altScreenParams.has(v))) return false;
          return true;
        }
      );
      this.disposables.push(decsetPrivateHandler);

      const decrstPrivateHandler = terminal.parser.registerCsiHandler(
        { prefix: "?", final: "l" },
        (params) => {
          if (!this.shouldBlock()) return false;
          const p = this.normalizeCsiParams(params);
          if (!p.some((v) => altScreenParams.has(v))) return false;
          return true;
        }
      );
      this.disposables.push(decrstPrivateHandler);
    }

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
