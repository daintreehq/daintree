import { ManagedTerminal } from "./types";
import { getAgentConfig } from "@/config/agents";

export class TerminalParserHandler {
  private managed: ManagedTerminal;
  private disposables: Array<{ dispose: () => void }> = [];

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

    if (!terminal.parser || !terminal.parser.registerEscHandler) {
      return; // Graceful degradation if proposed API missing
    }

    const capabilities = this.getAgentCapabilities();

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
