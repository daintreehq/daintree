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
  disposeAll: vi.fn(async () => undefined),
}));

/** The deps `registerSitePreviewHandlers` hands the bridge, `push` among them. */
const captured = vi.hoisted(() => ({ deps: null as { push?: unknown } | null }));

vi.mock("../../../services/SitePreviewBridge.js", () => ({
  getSitePreviewBridge: (deps?: { push?: unknown }) => {
    if (deps) captured.deps = deps;
    return bridge;
  },
  resetSitePreviewBridge: vi.fn(),
}));

vi.mock("../../../services/sitePreview/builtinGuestAdapters.js", () => ({
  registerBuiltinGuestAdapters: () => () => undefined,
}));

const projectViews = vi.hoisted(
  () => new Map<string, Array<{ id: number; isDestroyed: () => boolean; send: unknown }>>()
);

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: (projectId: string) => projectViews.get(projectId) ?? [],
}));

// The namespace wires `ipcMain.handle` on register; the routing under test is
// the push closure, not the registration.
vi.mock("../../utils.js", () => ({
  typedHandle: () => () => undefined,
  typedHandleValidated: () => () => undefined,
  typedHandleWithContext: () => () => undefined,
  typedHandleWithContextValidated: () => () => undefined,
}));

const ADAPTER_ID = "daintree.sveltekit-builder.guest";

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
  });

  it("exposes no way to evaluate caller-supplied script in a guest", async () => {
    const names = Object.keys(await ops());
    // A bind names a host-registered adapter; the host loads the body. An
    // `evaluate` op here would be arbitrary code execution inside the user's
    // site, so this is a boundary worth pinning rather than a naming preference.
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
      all.bind.handler(ctx(null), { panelId: "p", adapterId: ADAPTER_ID, mode: "browse" })
    ).rejects.toThrow(/project/i);
    await expect(all.detach.handler(ctx(null), { sessionId: "s1" })).rejects.toThrow(/project/i);
    await expect(all.getState.handler(ctx(null), { sessionId: "s1" })).rejects.toThrow(/project/i);
    expect(bridge.bind).not.toHaveBeenCalled();
  });

  it("passes the context's project to the bridge, not anything from the payload", async () => {
    const all = await ops();
    await all.bind.handler(ctx("project-a"), {
      panelId: "panel-1",
      adapterId: ADAPTER_ID,
      // A caller-supplied project must not be able to reach the bridge; the
      // schema is strict, so this is rejected before the handler body runs.
      mode: "select",
    });
    expect(bridge.bind).toHaveBeenCalledWith({
      projectId: "project-a",
      panelId: "panel-1",
      adapterId: ADAPTER_ID,
      mode: "select",
      subscriberWebContentsId: 1,
    });
  });

  it("gives the bridge the sender as the binding's subscriber", async () => {
    const all = await ops();
    await all.bind.handler(
      { ...ctx("project-a"), webContentsId: 9 },
      {
        panelId: "panel-1",
        adapterId: ADAPTER_ID,
      }
    );
    // The address observations go back to is the sender the host proved, and it
    // is never something the payload can name.
    expect(bridge.bind).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberWebContentsId: 9 })
    );
    expect(
      all.bind.schema.safeParse({ panelId: "p", adapterId: ADAPTER_ID, webContentsId: 3 }).success
    ).toBe(false);
  });

  it("defaults the mode to browse when the caller omits it", async () => {
    const all = await ops();
    await all.bind.handler(ctx("project-a"), { panelId: "panel-1", adapterId: ADAPTER_ID });
    expect(bridge.bind).toHaveBeenCalledWith(expect.objectContaining({ mode: "browse" }));
  });

  it("rejects payloads carrying fields the contract does not define", async () => {
    const all = await ops();
    const parsed = all.bind.schema.safeParse({
      panelId: "panel-1",
      adapterId: ADAPTER_ID,
      projectId: "project-b",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts no way to put script on the wire", async () => {
    const all = await ops();
    // The body is the host's to choose. A payload carrying source is not a
    // larger bind, it is a different contract, and the schema must refuse it.
    expect(
      all.bind.schema.safeParse({
        panelId: "panel-1",
        adapterId: ADAPTER_ID,
        runtimeSource: "globalThis.x = 1",
      }).success
    ).toBe(false);
    expect(all.bind.schema.safeParse({ panelId: "panel-1" }).success).toBe(false);
    expect(all.bind.schema.safeParse({ panelId: "panel-1", adapterId: "" }).success).toBe(false);
    expect(
      all.bind.schema.safeParse({ panelId: "panel-1", adapterId: "x".repeat(600) }).success
    ).toBe(false);
  });
});

/**
 * A guest observation carries the user's page structure, their selection and
 * source locations from their repository. It goes to the view that established
 * the binding, and to nothing else — a second window on the same project, and
 * every other plugin view sharing that renderer realm, never asked for it.
 */
describe("sitePreview event routing", () => {
  function view(id: number) {
    return { id, isDestroyed: () => false, send: vi.fn() };
  }

  async function push(
    payload: { kind: string; projectId: string },
    route: { subscriberWebContentsId: number }
  ) {
    const { registerSitePreviewHandlers } = await import("../sitePreview.js");
    const dispose = registerSitePreviewHandlers({});
    const send = captured.deps?.push as
      ((p: unknown, r: { subscriberWebContentsId: number }) => void) | undefined;
    expect(send).toBeTypeOf("function");
    send?.(payload, route);
    dispose();
  }

  beforeEach(() => {
    vi.resetModules();
    projectViews.clear();
    captured.deps = null;
  });

  it("delivers only to the view that bound, not to the project's other views", async () => {
    const owner = view(1);
    const bystander = view(2);
    projectViews.set("project-a", [owner, bystander]);

    await push({ kind: "guest-event", projectId: "project-a" }, { subscriberWebContentsId: 1 });

    expect(owner.send).toHaveBeenCalledTimes(1);
    expect(owner.send).toHaveBeenCalledWith(CHANNELS.SITE_PREVIEW_EVENT, {
      kind: "guest-event",
      projectId: "project-a",
    });
    expect(bystander.send).not.toHaveBeenCalled();
  });

  it("delivers nothing when the subscriber is no longer a live view of the project", async () => {
    const replacement = view(2);
    projectViews.set("project-a", [replacement]);

    // The view that bound was destroyed or evicted; its successor is a
    // different WebContents that never established this binding.
    await push({ kind: "guest-event", projectId: "project-a" }, { subscriberWebContentsId: 1 });

    expect(replacement.send).not.toHaveBeenCalled();
  });

  it("never reaches a view of another project that happens to share the id", async () => {
    const foreign = view(1);
    projectViews.set("project-b", [foreign]);
    projectViews.set("project-a", []);

    await push({ kind: "guest-event", projectId: "project-a" }, { subscriberWebContentsId: 1 });

    expect(foreign.send).not.toHaveBeenCalled();
  });
});
