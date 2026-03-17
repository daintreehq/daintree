import type { PtyClient } from "./PtyClient.js";
import { UrlDetector } from "./UrlDetector.js";
import type { DetectedDevServer } from "../../shared/types/ipc/globalDevServers.js";

interface TrackedTerminal {
  buffer: string;
  urlFound: boolean;
  worktreeId?: string;
  title?: string;
}

export class GlobalTerminalScannerService {
  private tracked = new Map<string, TrackedTerminal>();
  private serversByPort = new Map<number, DetectedDevServer>();
  private urlDetector = new UrlDetector();
  private onChangedCallback: ((servers: DetectedDevServer[]) => void) | null = null;
  private readonly textDecoder = new TextDecoder();

  private dataHandler: (id: string, data: string | Uint8Array) => void;
  private exitHandler: (id: string, exitCode: number) => void;
  private spawnResultHandler: (id: string, result: { success: boolean }) => void;

  constructor(private ptyClient: PtyClient) {
    this.dataHandler = (id, data) => this.handleData(id, data);
    this.exitHandler = (id) => this.handleExit(id);
    this.spawnResultHandler = (id, result) => this.handleSpawnResult(id, result);

    this.ptyClient.on("data", this.dataHandler);
    this.ptyClient.on("exit", this.exitHandler);
    this.ptyClient.on("spawn-result", this.spawnResultHandler);

    void this.initSweep();
  }

  private async initSweep(): Promise<void> {
    try {
      const terminals = await this.ptyClient.getAllTerminalsAsync();
      for (const t of terminals) {
        if (t.hasPty && t.kind !== "dev-preview") {
          this.trackTerminal(t.id, t.worktreeId, t.title);
        }
      }
    } catch {
      // Silently handle init sweep failure
    }
  }

  private trackTerminal(id: string, worktreeId?: string, title?: string): void {
    if (this.tracked.has(id)) return;
    this.tracked.set(id, { buffer: "", urlFound: false, worktreeId, title });
    this.ptyClient.setIpcDataMirror(id, true);
  }

  private async handleSpawnResult(id: string, result: { success: boolean }): Promise<void> {
    if (!result.success) return;
    try {
      const info = await this.ptyClient.getTerminalAsync(id);
      if (!info || info.kind === "dev-preview" || info.hasPty === false) return;
      this.trackTerminal(info.id, info.worktreeId, info.title);
    } catch {
      // Ignore lookup failures
    }
  }

  private handleData(id: string, data: string | Uint8Array): void {
    const entry = this.tracked.get(id);
    if (!entry || entry.urlFound) return;

    const text = typeof data === "string" ? data : this.textDecoder.decode(data);
    const result = this.urlDetector.scanOutput(text, entry.buffer);
    entry.buffer = result.buffer;

    if (result.url) {
      let port: number;
      try {
        port = parseInt(new URL(result.url).port, 10) || 80;
      } catch {
        return;
      }

      entry.urlFound = true;
      this.ptyClient.setIpcDataMirror(id, false);

      this.serversByPort.set(port, {
        url: result.url,
        port,
        terminalId: id,
        worktreeId: entry.worktreeId,
        terminalTitle: entry.title,
        detectedAt: Date.now(),
      });

      this.emitChanged();
    }
  }

  private handleExit(id: string): void {
    const entry = this.tracked.get(id);
    if (!entry) return;

    this.tracked.delete(id);
    this.ptyClient.setIpcDataMirror(id, false);

    let removed = false;
    for (const [port, server] of this.serversByPort) {
      if (server.terminalId === id) {
        this.serversByPort.delete(port);
        removed = true;
      }
    }
    if (removed) {
      this.emitChanged();
    }
  }

  private emitChanged(): void {
    this.onChangedCallback?.(this.getAll());
  }

  getAll(): DetectedDevServer[] {
    return Array.from(this.serversByPort.values()).sort((a, b) => a.detectedAt - b.detectedAt);
  }

  onChanged(callback: (servers: DetectedDevServer[]) => void): void {
    this.onChangedCallback = callback;
  }

  dispose(): void {
    this.ptyClient.removeListener("data", this.dataHandler);
    this.ptyClient.removeListener("exit", this.exitHandler);
    this.ptyClient.removeListener("spawn-result", this.spawnResultHandler);

    for (const id of this.tracked.keys()) {
      this.ptyClient.setIpcDataMirror(id, false);
    }

    this.tracked.clear();
    this.serversByPort.clear();
    this.onChangedCallback = null;
  }
}
