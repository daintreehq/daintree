import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../channels.js";
import { SITE_PREVIEW_METHOD_CHANNELS } from "../sitePreview.preload.js";
import type { IpcContext } from "../../types.js";

const bridge = vi.hoisted(() => ({
  listCandidates: vi.fn(() => []),
  bind: vi.fn(async () => ({ sessionId: "s1" })),
  detach: vi.fn(async () => undefined),
  setMode: vi.fn(async () => ({ sessionId: "s1" })),
  getState: vi.fn(() => null),
}));

vi.mock("../../../services/SitePreviewBridge.js", () => ({
  getSitePreviewBridge: () => bridge,
  resetSitePreviewBridge: vi.fn(),
}));

function ctx(projectId: string | null): IpcContext {
  return {
    event: {} as Electron.IpcMainInvokeEvent,
    webContentsId: 1,
    senderWindow: null,
    projectId,
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
  });

  it("exposes no way to evaluate caller-supplied script in a guest", async () => {
    const names = Object.keys(await ops());
    // The runtime body is handed over once at bind time. An `evaluate` op here
    // would be arbitrary code execution inside the user's site, so this is a
    // boundary worth pinning rather than a naming preference.
    expect(names.filter((name) => /eval|exec|inject|script/i.test(name))).toEqual([]);
    expect(names.sort()).toEqual(Object.keys(SITE_PREVIEW_METHOD_CHANNELS).sort());
  });

  it("declares every channel through CHANNELS", async () => {
    const declared = new Set(Object.values(CHANNELS));
    for (const spec of Object.values(await ops())) {
      expect(declared.has(spec.channel)).toBe(true);
    }
    expect(declared.has(CHANNELS.SITE_PREVIEW_EVENT)).toBe(true);
  });

  it("refuses every operation from a sender with no project", async () => {
    const all = await ops();
    await expect(all.listCandidates.handler(ctx(null))).rejects.toThrow(/project/i);
    await expect(
      all.bind.handler(ctx(null), { panelId: "p", runtimeSource: "x", mode: "browse" })
    ).rejects.toThrow(/project/i);
    await expect(all.detach.handler(ctx(null), { sessionId: "s1" })).rejects.toThrow(/project/i);
    await expect(all.getState.handler(ctx(null), { sessionId: "s1" })).rejects.toThrow(/project/i);
    expect(bridge.bind).not.toHaveBeenCalled();
  });

  it("passes the context's project to the bridge, not anything from the payload", async () => {
    const all = await ops();
    await all.bind.handler(ctx("project-a"), {
      panelId: "panel-1",
      runtimeSource: "runtime",
      // A caller-supplied project must not be able to reach the bridge; the
      // schema is strict, so this is rejected before the handler body runs.
      mode: "select",
    });
    expect(bridge.bind).toHaveBeenCalledWith({
      projectId: "project-a",
      panelId: "panel-1",
      runtimeSource: "runtime",
      mode: "select",
    });
  });

  it("defaults the mode to browse when the caller omits it", async () => {
    const all = await ops();
    await all.bind.handler(ctx("project-a"), { panelId: "panel-1", runtimeSource: "runtime" });
    expect(bridge.bind).toHaveBeenCalledWith(expect.objectContaining({ mode: "browse" }));
  });

  it("rejects payloads carrying fields the contract does not define", async () => {
    const all = await ops();
    const parsed = all.bind.schema.safeParse({
      panelId: "panel-1",
      runtimeSource: "runtime",
      projectId: "project-b",
    });
    expect(parsed.success).toBe(false);
  });

  it("caps the runtime source a single bind can carry", async () => {
    const all = await ops();
    const parsed = all.bind.schema.safeParse({
      panelId: "panel-1",
      runtimeSource: "x".repeat(600_000),
    });
    expect(parsed.success).toBe(false);
  });
});
