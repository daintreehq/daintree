import type { RendererPanelProjectionPublish } from "../../../shared/types/ipc/remotePanelProjection.js";
import type { RendererPanelProjection } from "./RemoteProjectDetailProjectionService.js";

interface ProjectionEntry extends RendererPanelProjection {
  webContentsId: number;
  destroyCleanup: () => void;
}

export interface RemoteRendererBinding {
  projectId: string;
  webContentsId: number;
  generation: number;
  status: RendererPanelProjection["status"];
}

interface ProjectionSender {
  id: number;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

export class RemoteRendererPanelRegistry {
  private readonly entries = new Map<string, ProjectionEntry>();
  private readonly listeners = new Set<(binding: RemoteRendererBinding) => void>();
  private generation = 0;

  publish(payload: RendererPanelProjectionPublish, sender: ProjectionSender): void {
    if (sender.isDestroyed()) return;
    const previous = this.entries.get(payload.projectId);
    if (previous?.webContentsId === sender.id) {
      if (payload.status === "loading" && previous.status !== "loading") {
        this.generation += 1;
        previous.rendererGeneration = this.generation;
      }
      const nextFingerprint = JSON.stringify(payload.panels);
      const previousFingerprint = JSON.stringify(previous.panels);
      if (nextFingerprint === previousFingerprint && previous.status === "available") return;
      previous.panels = payload.status === "loading" ? previous.panels : payload.panels;
      previous.revision += 1;
      previous.status = payload.status;
      this.emit(previous);
      return;
    }

    previous?.destroyCleanup();
    this.generation += 1;
    const onDestroyed = () => this.markEvicted(payload.projectId, sender.id);
    sender.once("destroyed", onDestroyed);
    this.entries.set(payload.projectId, {
      projectId: payload.projectId,
      webContentsId: sender.id,
      rendererGeneration: this.generation,
      revision: 1,
      status: payload.status,
      panels: payload.status === "loading" ? (previous?.panels ?? []) : payload.panels,
      destroyCleanup: () => sender.removeListener("destroyed", onDestroyed),
    });
    this.emit(this.entries.get(payload.projectId)!);
  }

  get(projectId: string): RendererPanelProjection | null {
    const entry = this.entries.get(projectId);
    if (!entry) return null;
    return {
      projectId: entry.projectId,
      rendererGeneration: entry.rendererGeneration,
      revision: entry.revision,
      status: entry.status,
      panels: entry.panels,
    };
  }

  getBinding(projectId: string): RemoteRendererBinding | null {
    const entry = this.entries.get(projectId);
    if (!entry) return null;
    return {
      projectId: entry.projectId,
      webContentsId: entry.webContentsId,
      generation: entry.rendererGeneration,
      status: entry.status,
    };
  }

  subscribe(listener: (binding: RemoteRendererBinding) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  markEvicted(projectId: string, webContentsId?: number): void {
    const entry = this.entries.get(projectId);
    if (!entry || (webContentsId !== undefined && entry.webContentsId !== webContentsId)) return;
    entry.destroyCleanup();
    entry.status = "evicted";
    entry.revision += 1;
    this.emit(entry);
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.destroyCleanup();
    this.entries.clear();
    this.listeners.clear();
  }

  private emit(entry: ProjectionEntry): void {
    const binding = this.getBinding(entry.projectId);
    if (!binding) return;
    for (const listener of this.listeners) listener(binding);
  }
}

export const remoteRendererPanelRegistry = new RemoteRendererPanelRegistry();
