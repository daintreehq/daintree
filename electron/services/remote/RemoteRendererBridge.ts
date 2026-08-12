import { ipcMain, webContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  RemoteRendererRequestSchema,
  RemoteRendererResponseSchema,
  type RemoteRendererRequest,
  type RemoteRendererResponse,
} from "../../../shared/types/ipc/remoteRendererBridge.js";
import type { RemoteLaunchableAgents } from "../../../shared/types/remote/index.js";
import { CHANNELS } from "../../ipc/channels.js";
import type { RemoteProjectViewBinding } from "./RemoteProjectViewBroker.js";
import type { RemoteRendererPanelRegistry } from "./RemoteRendererPanelRegistry.js";

const REMOTE_RENDERER_REQUEST_TIMEOUT_MS = 15_000;

type PanelResponse = Extract<
  RemoteRendererResponse,
  { method: "remote:getPanelProjection"; ok: true }
>;
type LaunchResponse = Extract<RemoteRendererResponse, { method: "remote:launchAgent"; ok: true }>;

interface PendingRequest {
  request: RemoteRendererRequest;
  resolve: (response: RemoteRendererResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

export class RemoteRendererBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RemoteRendererBridgeError";
  }
}

export class RemoteRendererBridge {
  private readonly pending = new Map<string, PendingRequest>();
  private started = false;
  private disposed = false;

  constructor(
    private readonly registry: Pick<RemoteRendererPanelRegistry, "getBinding" | "markEvicted">,
    private readonly timeoutMs = REMOTE_RENDERER_REQUEST_TIMEOUT_MS
  ) {}

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    ipcMain.on(CHANNELS.REMOTE_RENDERER_RESPONSE, this.onResponse);
  }

  async getPanelProjection(binding: RemoteProjectViewBinding): Promise<PanelResponse["result"]> {
    const response = await this.request({
      ...this.envelope(binding),
      method: "remote:getPanelProjection",
    });
    if (response.method !== "remote:getPanelProjection" || !response.ok) {
      throw new RemoteRendererBridgeError("INVALID_RESPONSE", "Unexpected renderer response");
    }
    return response.result;
  }

  async getLaunchableAgents(
    binding: RemoteProjectViewBinding,
    worktreeId: string
  ): Promise<RemoteLaunchableAgents> {
    const response = await this.request({
      ...this.envelope(binding),
      method: "remote:getLaunchableAgents",
      worktreeId,
    });
    if (response.method !== "remote:getLaunchableAgents" || !response.ok) {
      throw new RemoteRendererBridgeError("INVALID_RESPONSE", "Unexpected renderer response");
    }
    return response.result;
  }

  async launchAgent(
    binding: RemoteProjectViewBinding,
    input: {
      worktreeId: string;
      agentId: string;
      requestedPanelId: string;
      prompt?: string;
      presetId?: string | null;
      modelId?: string;
      name?: string;
    }
  ): Promise<LaunchResponse["result"]> {
    const response = await this.request({
      ...this.envelope(binding),
      method: "remote:launchAgent",
      ...input,
      source: "remote",
      persistent: true,
      focusPolicy: "preserve",
    });
    if (response.method !== "remote:launchAgent" || !response.ok) {
      throw new RemoteRendererBridgeError("INVALID_RESPONSE", "Unexpected renderer response");
    }
    return response.result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      ipcMain.removeListener(CHANNELS.REMOTE_RENDERER_RESPONSE, this.onResponse);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(new RemoteRendererBridgeError("HOST_SHUTDOWN", "Renderer bridge stopped"));
    }
    this.pending.clear();
  }

  private envelope(binding: RemoteProjectViewBinding) {
    return {
      requestId: randomUUID(),
      projectId: binding.projectId,
      webContentsId: binding.webContentsId,
      rendererGeneration: binding.generation,
    };
  }

  private request(rawRequest: RemoteRendererRequest): Promise<RemoteRendererResponse> {
    if (this.disposed) {
      return Promise.reject(
        new RemoteRendererBridgeError("HOST_SHUTDOWN", "Renderer bridge stopped")
      );
    }
    if (!this.started) this.start();
    const parsed = RemoteRendererRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      return Promise.reject(
        new RemoteRendererBridgeError("INVALID_REQUEST", "Renderer request failed validation")
      );
    }
    const request = parsed.data;
    try {
      this.assertBinding(request);
    } catch (error) {
      return Promise.reject(error);
    }
    const sender = webContents.fromId(request.webContentsId);
    if (!sender || sender.isDestroyed()) {
      this.registry.markEvicted(request.projectId, request.webContentsId);
      return Promise.reject(
        new RemoteRendererBridgeError("UNAVAILABLE", "Project renderer is unavailable")
      );
    }

    return new Promise((resolve, reject) => {
      const onDestroyed = () => {
        this.registry.markEvicted(request.projectId, request.webContentsId);
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(request.requestId);
        pending.reject(
          new RemoteRendererBridgeError("UNAVAILABLE", "Project renderer was destroyed")
        );
      };
      sender.once("destroyed", onDestroyed);
      const cleanup = () => sender.removeListener("destroyed", onDestroyed);
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        pending.cleanup();
        this.pending.delete(request.requestId);
        pending.reject(new RemoteRendererBridgeError("TIMEOUT", "Renderer request timed out"));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(request.requestId, { request, resolve, reject, timer, cleanup });
      try {
        sender.send(CHANNELS.REMOTE_RENDERER_REQUEST, request);
      } catch (error) {
        clearTimeout(timer);
        cleanup();
        this.pending.delete(request.requestId);
        reject(
          error instanceof Error
            ? error
            : new RemoteRendererBridgeError("UNAVAILABLE", "Renderer request failed")
        );
      }
    });
  }

  private readonly onResponse = (event: Electron.IpcMainEvent, payload: unknown): void => {
    const requestId =
      payload && typeof payload === "object" && "requestId" in payload
        ? (payload as { requestId?: unknown }).requestId
        : undefined;
    if (typeof requestId !== "string") return;
    const pending = this.pending.get(requestId);
    if (!pending || event.sender.id !== pending.request.webContentsId) return;
    const parsed = RemoteRendererResponseSchema.safeParse(payload);
    if (!parsed.success) {
      this.settleError(
        requestId,
        new RemoteRendererBridgeError("INVALID_RESPONSE", "Renderer response failed validation")
      );
      return;
    }
    const response = parsed.data;
    if (
      response.method !== pending.request.method ||
      response.projectId !== pending.request.projectId ||
      response.webContentsId !== pending.request.webContentsId ||
      response.rendererGeneration !== pending.request.rendererGeneration
    ) {
      this.settleError(
        requestId,
        new RemoteRendererBridgeError("BINDING_STALE", "Renderer response binding changed")
      );
      return;
    }
    try {
      this.assertBinding(pending.request);
    } catch (error) {
      this.settleError(
        requestId,
        error instanceof Error ? error : new Error("Renderer binding changed")
      );
      return;
    }
    clearTimeout(pending.timer);
    pending.cleanup();
    this.pending.delete(requestId);
    if (!response.ok) {
      pending.reject(new RemoteRendererBridgeError(response.error.code, response.error.message));
      return;
    }
    pending.resolve(response);
  };

  private settleError(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.cleanup();
    this.pending.delete(requestId);
    pending.reject(error);
  }

  private assertBinding(
    request: Pick<RemoteRendererRequest, "projectId" | "webContentsId" | "rendererGeneration">
  ): void {
    const binding = this.registry.getBinding(request.projectId);
    if (
      !binding ||
      binding.status !== "available" ||
      binding.webContentsId !== request.webContentsId ||
      binding.generation !== request.rendererGeneration
    ) {
      throw new RemoteRendererBridgeError("BINDING_STALE", "Project renderer binding changed");
    }
  }
}
