import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../channels.js";
import { SITE_PREVIEW_METHOD_CHANNELS } from "../sitePreview.preload.js";
import type { IpcContext } from "../../types.js";

const bridge = vi.hoisted(() => ({
  detach: vi.fn(async () => undefined),
  setMode: vi.fn(async () => ({ sessionId: "s1" })),
  clearSelection: vi.fn(async () => undefined),
  clearHover: vi.fn(async () => undefined),
  disposeAll: vi.fn(async () => undefined),
}));

const lifecycle = vi.hoisted(() => ({
  created: 0,
  reset: vi.fn(),
}));

vi.mock("../../../services/SitePreviewBridge.js", () => ({
  getSitePreviewBridge: (deps?: unknown) => {
    if (deps) lifecycle.created += 1;
    return bridge;
  },
  resetSitePreviewBridge: lifecycle.reset,
}));

// The namespace wires `ipcMain.handle` on register; what is under test is the
// handler bodies and the registration's disposal, not the wiring.
vi.mock("../../utils.js", () => ({
  typedHandle: () => () => undefined,
  typedHandleValidated: () => () => undefined,
  typedHandleWithContext: () => () => undefined,
  typedHandleWithContextValidated: () => () => undefined,
}));

function ctx(projectId: string | null): IpcContext {
  return {
    event: {} as Electron.IpcMainInvokeEvent,
    webContentsId: 1,
    senderWindow: null,
    projectId,
    endpoint: {} as IpcContext["endpoint"],
    client: {} as IpcContext["client"],
  };
}

async function ops() {
  const { sitePreviewNamespace } = await import("../sitePreview.js");
  return sitePreviewNamespace.ops;
}

describe("sitePreview handlers", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(bridge).forEach((fn) => fn.mockClear());
    lifecycle.created = 0;
    lifecycle.reset.mockClear();
  });

  it("exposes no way to evaluate caller-supplied script in a guest", async () => {
    const names = Object.keys(await ops());
    // An `evaluate` op here would be arbitrary code execution inside the
    // user's site, so this is a boundary worth pinning rather than a naming
    // preference.
    expect(names.filter((name) => /eval|exec|inject|script/i.test(name))).toEqual([]);
    expect(names.sort()).toEqual(Object.keys(SITE_PREVIEW_METHOD_CHANNELS).sort());
  });

  it("declares every channel through CHANNELS", async () => {
    const declared = new Set(Object.values(CHANNELS));
    for (const spec of Object.values(await ops())) {
      expect(declared.has(spec.channel)).toBe(true);
    }
  });

  it("refuses every operation from a sender with no project", async () => {
    const all = await ops();
    await expect(all.detach.handler(ctx(null), { sessionId: "s1" })).rejects.toThrow(/project/i);
    await expect(
      all.setMode.handler(ctx(null), { sessionId: "s1", mode: "select" })
    ).rejects.toThrow(/project/i);
    await expect(all.clearSelection.handler(ctx(null), { sessionId: "s1" })).rejects.toThrow(
      /project/i
    );
    await expect(all.clearHover.handler(ctx(null), { sessionId: "s1" })).rejects.toThrow(
      /project/i
    );
    for (const fn of Object.values(bridge)) expect(fn).not.toHaveBeenCalled();
  });

  it("passes the context's project to the bridge, not anything from the payload", async () => {
    const all = await ops();
    await all.detach.handler(ctx("project-a"), { sessionId: "s1" });
    await all.setMode.handler(ctx("project-a"), { sessionId: "s1", mode: "select" });
    await all.clearSelection.handler(ctx("project-a"), { sessionId: "s1" });
    await all.clearHover.handler(ctx("project-a"), { sessionId: "s1" });

    expect(bridge.detach).toHaveBeenCalledWith("project-a", "s1");
    expect(bridge.setMode).toHaveBeenCalledWith("project-a", "s1", "select");
    expect(bridge.clearSelection).toHaveBeenCalledWith("project-a", "s1");
    expect(bridge.clearHover).toHaveBeenCalledWith("project-a", "s1");
  });

  it("rejects payloads carrying fields the contract does not define", async () => {
    const all = await ops();
    expect(all.detach.schema.safeParse({ sessionId: "s1", projectId: "project-b" }).success).toBe(
      false
    );
    expect(
      all.setMode.schema.safeParse({ sessionId: "s1", mode: "select", script: "x" }).success
    ).toBe(false);
    expect(all.setMode.schema.safeParse({ sessionId: "s1", mode: "inspect" }).success).toBe(false);
    expect(all.clearHover.schema.safeParse({ sessionId: "" }).success).toBe(false);
    expect(all.clearSelection.schema.safeParse({ sessionId: "x".repeat(200) }).success).toBe(false);
  });

  it("creates the bridge on registration and disposes and resets it on teardown", async () => {
    const { registerSitePreviewHandlers } = await import("../sitePreview.js");
    const dispose = registerSitePreviewHandlers({});
    expect(lifecycle.created).toBe(1);
    expect(bridge.disposeAll).not.toHaveBeenCalled();

    dispose();
    expect(bridge.disposeAll).toHaveBeenCalledTimes(1);
    expect(lifecycle.reset).toHaveBeenCalledTimes(1);
  });
});
