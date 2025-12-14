import { ManagedTerminal } from "./types";

export class TerminalParserHandler {
  private managed: ManagedTerminal;
  private disposables: Array<{ dispose: () => void }> = [];
  private allowResets = false;

  constructor(managed: ManagedTerminal) {
    this.managed = managed;
    this.attachHandlers();
  }

  setAllowResets(allow: boolean): void {
    this.allowResets = allow;
  }

  private attachHandlers(): void {
    const { terminal } = this.managed;

    if (!terminal.parser || !terminal.parser.registerEscHandler) {
      return; // Graceful degradation if proposed API missing
    }

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
    const decstrHandler = terminal.parser.registerCsiHandler({ prefix: "!", final: "p" }, () => {
      if (this.allowResets) return false;
      if (!this.shouldBlock()) return false;

      if (process.env.NODE_ENV === "development") {
        console.warn(
          `[TerminalParser] Blocked DECSTR (CSI ! p) for agent terminal ${this.managed.agentId || "unknown"}`
        );
      }
      return true; // Swallow the sequence
    });
    this.disposables.push(decstrHandler);
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
