import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RemoteRendererPanelRegistry } from "../RemoteRendererPanelRegistry.js";

class FakeSender extends EventEmitter {
  destroyed = false;

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

const payload = {
  projectId: "project-1",
  status: "available" as const,
  panels: [
    {
      panelId: "panel-1",
      worktreeSourceId: "/private/worktrees/main",
      agentId: "codex",
      displayName: "Codex",
      title: "Implement projection",
      spawnedRemotely: false,
      resumable: true,
      connectionState: "live" as const,
    },
  ],
};

describe("RemoteRendererPanelRegistry", () => {
  it("retains the last safe projection and marks it evicted when its renderer exits", () => {
    const registry = new RemoteRendererPanelRegistry();
    const sender = new FakeSender(7);
    registry.publish(payload, sender);
    const live = registry.get(payload.projectId)!;
    expect(live).toMatchObject({ status: "available", revision: 1, rendererGeneration: 1 });

    sender.destroy();

    expect(registry.get(payload.projectId)).toMatchObject({
      status: "evicted",
      revision: 2,
      rendererGeneration: live.rendererGeneration,
      panels: payload.panels,
    });
  });

  it("mints a new renderer generation on replacement and ignores stale destruction", () => {
    const registry = new RemoteRendererPanelRegistry();
    const first = new FakeSender(7);
    const replacement = new FakeSender(8);
    registry.publish(payload, first);
    registry.publish(
      { ...payload, panels: [{ ...payload.panels[0]!, title: "Replacement" }] },
      replacement
    );

    first.destroy();

    expect(registry.get(payload.projectId)).toMatchObject({
      status: "available",
      rendererGeneration: 2,
      panels: [{ title: "Replacement" }],
    });
  });

  it("publishes exact webContents and generation readiness changes to broker subscribers", () => {
    const registry = new RemoteRendererPanelRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const sender = new FakeSender(9);

    registry.publish({ ...payload, status: "loading", panels: [] }, sender);
    registry.publish(payload, sender);
    sender.destroy();

    expect(listener.mock.calls.map(([binding]) => binding)).toEqual([
      {
        projectId: "project-1",
        webContentsId: 9,
        generation: 1,
        status: "loading",
      },
      {
        projectId: "project-1",
        webContentsId: 9,
        generation: 1,
        status: "available",
      },
      {
        projectId: "project-1",
        webContentsId: 9,
        generation: 1,
        status: "evicted",
      },
    ]);
    expect(registry.getBinding("project-1")).toEqual(listener.mock.calls.at(-1)?.[0]);
    unsubscribe();
    registry.publish(payload, new FakeSender(10));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("mints a new generation when the same WebContents begins a renderer reload", () => {
    const registry = new RemoteRendererPanelRegistry();
    const sender = new FakeSender(11);
    registry.publish(payload, sender);
    const first = registry.getBinding("project-1")!;

    registry.publish({ ...payload, status: "loading", panels: [] }, sender);
    const loading = registry.getBinding("project-1")!;
    registry.publish(payload, sender);
    const reloaded = registry.getBinding("project-1")!;

    expect(loading.generation).toBeGreaterThan(first.generation);
    expect(reloaded).toMatchObject({
      webContentsId: first.webContentsId,
      generation: loading.generation,
      status: "available",
    });
  });
});
