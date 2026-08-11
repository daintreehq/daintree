import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import { RemoteRendererBridge, RemoteRendererBridgeError } from "../RemoteRendererBridge.js";

const electronMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  return {
    fromId: vi.fn(),
    ipcMain: {
      on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener);
        listeners.set(channel, set);
      }),
      removeListener: vi.fn(
        (channel: string, listener: (event: unknown, payload: unknown) => void) => {
          listeners.get(channel)?.delete(listener);
        }
      ),
      emit(channel: string, event: unknown, payload: unknown) {
        for (const listener of listeners.get(channel) ?? []) listener(event, payload);
      },
    },
    reset() {
      listeners.clear();
      vi.clearAllMocks();
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain,
  webContents: { fromId: electronMock.fromId },
}));

class Sender extends EventEmitter {
  readonly id = 41;
  readonly send = vi.fn();
  isDestroyed(): boolean {
    return false;
  }
}

const binding = { projectId: "project-1", webContentsId: 41, generation: 3 };

function fixture() {
  const sender = new Sender();
  const current = { ...binding, status: "available" as const };
  const registry = { getBinding: vi.fn(() => current) };
  electronMock.fromId.mockReturnValue(sender);
  const bridge = new RemoteRendererBridge(registry, 20);
  bridge.start();
  return { bridge, registry, sender, current };
}

beforeEach(() => electronMock.reset());

describe("RemoteRendererBridge", () => {
  it("sends a generation-bound launch with host-controlled source, persistence, and focus", async () => {
    const f = fixture();
    const launched = f.bridge.launchAgent(binding, {
      worktreeId: "worktree-1",
      agentId: "claude",
      requestedPanelId: "requested-panel-1",
    });
    const request = f.sender.send.mock.calls[0]![1];

    expect(f.sender.send).toHaveBeenCalledWith(
      CHANNELS.REMOTE_RENDERER_REQUEST,
      expect.objectContaining({
        method: "remote:launchAgent",
        projectId: "project-1",
        webContentsId: 41,
        rendererGeneration: 3,
        source: "remote",
        persistent: true,
        focusPolicy: "preserve",
      })
    );
    electronMock.ipcMain.emit(
      CHANNELS.REMOTE_RENDERER_RESPONSE,
      { sender: f.sender },
      {
        requestId: request.requestId,
        projectId: request.projectId,
        webContentsId: request.webContentsId,
        rendererGeneration: request.rendererGeneration,
        method: request.method,
        ok: true,
        result: {
          projectId: "project-1",
          worktreeId: "worktree-1",
          requestedPanelId: "requested-panel-1",
          panelId: "actual-panel-1",
          launchGeneration: 7,
          placement: "grid",
          spawnStatus: "starting",
          source: "remote",
          persistent: true,
          focusPolicy: "preserve",
        },
      }
    );

    await expect(launched).resolves.toMatchObject({ panelId: "actual-panel-1" });
    f.bridge.dispose();
  });

  it("fails immediately when the requested renderer is unavailable", async () => {
    const f = fixture();
    electronMock.fromId.mockReturnValue(null);

    await expect(f.bridge.getPanelProjection(binding)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    } satisfies Partial<RemoteRendererBridgeError>);
    expect(f.sender.send).not.toHaveBeenCalled();
    f.bridge.dispose();
  });

  it("rejects malformed and stale-generation responses from the exact sender", async () => {
    const malformed = fixture();
    const malformedRequest = malformed.bridge.getPanelProjection(binding);
    const malformedPayload = malformed.sender.send.mock.calls[0]![1];
    electronMock.ipcMain.emit(
      CHANNELS.REMOTE_RENDERER_RESPONSE,
      { sender: malformed.sender },
      { requestId: malformedPayload.requestId, ok: true }
    );
    await expect(malformedRequest).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    malformed.bridge.dispose();

    electronMock.reset();
    const stale = fixture();
    const staleRequest = stale.bridge.getPanelProjection(binding);
    const request = stale.sender.send.mock.calls[0]![1];
    stale.registry.getBinding.mockReturnValue({ ...stale.current, generation: 4 });
    electronMock.ipcMain.emit(
      CHANNELS.REMOTE_RENDERER_RESPONSE,
      { sender: stale.sender },
      {
        requestId: request.requestId,
        projectId: request.projectId,
        webContentsId: request.webContentsId,
        rendererGeneration: request.rendererGeneration,
        method: request.method,
        ok: true,
        result: { projectId: "project-1", status: "available", panels: [] },
      }
    );
    await expect(staleRequest).rejects.toMatchObject({ code: "BINDING_STALE" });
    stale.bridge.dispose();
  });
});
