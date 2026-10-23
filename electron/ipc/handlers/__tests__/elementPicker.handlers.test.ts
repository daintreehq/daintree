import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../channels.js";
import { getChannelLocality } from "../../channelLocality.js";
import { ELEMENT_PICKER_METHOD_CHANNELS } from "../elementPicker.preload.js";
import type { IpcContext } from "../../types.js";
import type { ClientEndpoint, Disposable, HostFrame } from "../../endpoint.js";
import { ELEMENT_PICKER_WORKSPACE_CLOSED } from "../../../../shared/types/ipc/elementPicker.js";

const bridge = vi.hoisted(() => ({
  bindElementPicker: vi.fn(async (input: { projectId: string; panelId: string }) => ({
    sessionId: "s1",
    panelId: input.panelId,
    projectId: input.projectId,
  })),
  reselectElementPicker: vi.fn(async () => true),
}));

vi.mock("../../../services/SitePreviewBridge.js", () => ({
  getSitePreviewBridge: () => bridge,
}));

const projectViews = vi.hoisted(
  () => new Map<string, Array<{ id: number; isDestroyed: () => boolean; send: unknown }>>()
);
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: (projectId: string) => projectViews.get(projectId) ?? [],
}));

const store = vi.hoisted(() => ({
  projects: new Map<string, { path: string; status?: string }>(),
  worktrees: new Map<string, Array<{ id: string; path: string }>>(),
}));
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: (id: string) => store.projects.get(id) ?? null },
}));
vi.mock("../../../window/serviceRefs.js", () => ({
  getWorkspaceClientRef: () => ({
    getAllStatesForProjectResultAsync: async (_projectPath: string, projectId: string) => {
      const states = store.worktrees.get(projectId);
      return states
        ? { status: "ok", projectId, states }
        : { status: "unavailable", reason: "project-unavailable" };
    },
  }),
}));

const host = vi.hoisted(() => ({
  registerWorkspace: vi.fn(async () => "ws-1"),
  releaseWorkspace: vi.fn(() => true),
  resolve: vi.fn(async () => ({ requestId: "r1", documentEpoch: 0, outcomes: [] })),
  describeProject: vi.fn(async () => ({ status: "none" })),
  sourceRevisions: vi.fn(async () => []),
}));
vi.mock("../../../services/elementPicker/index.js", () => ({
  getElementPickerHost: async () => host,
}));

vi.mock("../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

// The namespace wires `ipcMain.handle` on register; what is under test is the
// handlers themselves.
vi.mock("../../utils.js", () => ({
  typedHandle: () => () => undefined,
  typedHandleValidated: () => () => undefined,
  typedHandleWithContext: () => () => undefined,
  typedHandleWithContextValidated: () => () => undefined,
}));

class FakeEndpoint implements ClientEndpoint {
  readonly kind = "local-view" as const;
  readonly clientId = "local";
  readonly endpointId: string;
  readonly sent: HostFrame[] = [];
  constructor(
    readonly handle: number,
    readonly projectId: string | null
  ) {
    this.endpointId = `local:${handle}`;
  }
  send(frame: HostFrame): void {
    this.sent.push(frame);
  }
  request(): Promise<unknown> {
    return Promise.reject(new Error("unsupported"));
  }
  onClose(): Disposable {
    return { dispose: () => undefined };
  }
  isClosed(): boolean {
    return false;
  }
}

function ctx(projectId: string | null, webContentsId = 1): IpcContext {
  return {
    event: {} as Electron.IpcMainInvokeEvent,
    webContentsId,
    senderWindow: null,
    projectId,
    endpoint: new FakeEndpoint(webContentsId, projectId),
    client: {} as IpcContext["client"],
  };
}

async function ops() {
  const { elementPickerNamespace } = await import("../elementPicker.js");
  return elementPickerNamespace.ops;
}

let root: string;

beforeEach(() => {
  vi.resetModules();
  Object.values(bridge).forEach((fn) => fn.mockClear());
  Object.values(host).forEach((fn) => fn.mockClear());
  projectViews.clear();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "picker-handlers-")));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } })
  );
  store.projects.clear();
  store.worktrees.clear();
  store.projects.set("project-a", { path: root, status: "active" });
  store.worktrees.set("project-a", [{ id: "wt-1", path: root }]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("elementPicker handlers", () => {
  it("exposes the picker's operations and no way to run caller-supplied script", async () => {
    const names = Object.keys(await ops());
    expect(names.sort()).toEqual(Object.keys(ELEMENT_PICKER_METHOD_CHANNELS).sort());
    expect(names.filter((name) => /eval|exec|inject|script/i.test(name))).toEqual([]);
  });

  it("declares every channel through CHANNELS, each with the machine that answers it", async () => {
    const declared = new Set<string>(Object.values(CHANNELS));
    for (const spec of Object.values(await ops())) {
      expect(declared.has(spec.channel)).toBe(true);
    }
    for (const push of [CHANNELS.ELEMENT_PICKER_EVENT, CHANNELS.ELEMENT_PICKER_SOURCE_CHANGED]) {
      expect(declared.has(push)).toBe(true);
    }
    // The page is the showing machine's; the source is the worktree's.
    expect(getChannelLocality(CHANNELS.ELEMENT_PICKER_BIND)).toBe("shell");
    expect(getChannelLocality(CHANNELS.ELEMENT_PICKER_EVENT)).toBe("shell");
    expect(getChannelLocality(CHANNELS.ELEMENT_PICKER_RESOLVE)).toBe("host");
    expect(getChannelLocality(CHANNELS.ELEMENT_PICKER_SOURCE_CHANGED)).toBe("host");
  });

  it("refuses every operation from a sender with no project", async () => {
    const all = await ops();
    const calls = [
      all.bind.handler(ctx(null), { panelId: "p" }),
      all.reselect.handler(ctx(null), { sessionId: "s1" }),
      all.openWorkspace.handler(ctx(null), { panelId: "p", worktreeId: "wt-1" }),
      all.closeWorkspace.handler(ctx(null), { workspaceId: "ws-1" }),
      all.resolve.handler(ctx(null), { workspaceId: "ws-1" } as never),
      all.describeProject.handler(ctx(null), { workspaceId: "ws-1", url: "http://localhost/" }),
      all.sourceRevisions.handler(ctx(null), { workspaceId: "ws-1", paths: [] }),
    ];
    for (const call of calls) await expect(call).rejects.toMatchObject({ code: "PERMISSION" });
    expect(bridge.bindElementPicker).not.toHaveBeenCalled();
    expect(bridge.reselectElementPicker).not.toHaveBeenCalled();
    expect(host.registerWorkspace).not.toHaveBeenCalled();
    expect(host.resolve).not.toHaveBeenCalled();
  });

  it("takes no project, subscriber, path authority or script from the payload", async () => {
    const all = await ops();
    const refused: Array<[{ safeParse(value: unknown): { success: boolean } }, unknown]> = [
      [all.bind.schema, { panelId: "p", projectId: "project-b" }],
      [all.bind.schema, { panelId: "p", subscriberWebContentsId: 3 }],
      [all.reselect.schema, { sessionId: "s1", projectId: "project-b" }],
      [all.reselect.schema, { sessionId: "s1", script: "alert(1)" }],
      [all.reselect.schema, { sessionId: "s1", framework: "jquery" }],
      [
        all.reselect.schema,
        { sessionId: "s1", locator: { loc: { file: "a", line: 1, column: 0 }, index: 0, x: 1 } },
      ],
      [all.openWorkspace.schema, { panelId: "p", worktreeId: "wt-1", projectId: "project-b" }],
      [all.openWorkspace.schema, { panelId: "p", worktreeId: "wt-1", worktreePath: "/etc" }],
      [all.closeWorkspace.schema, { workspaceId: "ws-1", projectId: "project-b" }],
      [all.describeProject.schema, { workspaceId: "ws-1", url: `http://x/${"a".repeat(2048)}` }],
      [
        all.sourceRevisions.schema,
        { workspaceId: "ws-1", paths: Array.from({ length: 129 }, (_, i) => `f${i}`) },
      ],
      [all.resolve.schema, null],
      [all.resolve.schema, []],
      [all.resolve.schema, { requestId: "r1" }],
    ];
    for (const [schema, payload] of refused) {
      expect(schema.safeParse(payload).success, JSON.stringify(payload).slice(0, 80)).toBe(false);
    }
  });

  it("binds for the sender's project, and delivers the binding's traffic to the sender alone", async () => {
    const subscriber = { id: 9, isDestroyed: () => false, send: vi.fn() };
    const sibling = { id: 10, isDestroyed: () => false, send: vi.fn() };
    projectViews.set("project-a", [sibling, subscriber]);
    const all = await ops();

    await all.bind.handler(ctx("project-a", 9), { panelId: "panel-1" });

    expect(bridge.bindElementPicker).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-a",
        panelId: "panel-1",
        mode: "select",
        subscriberWebContentsId: 9,
      })
    );
    const { sink } = bridge.bindElementPicker.mock.calls[0]![0] as unknown as {
      sink: (payload: unknown) => void;
    };
    const payload = { kind: "picker-event", projectId: "project-a" };
    sink(payload);
    expect(subscriber.send).toHaveBeenCalledWith(CHANNELS.ELEMENT_PICKER_EVENT, payload);
    expect(sibling.send).not.toHaveBeenCalled();

    // The subscriber no longer a view of the binding's project: nothing goes anywhere.
    projectViews.set("project-a", [sibling]);
    projectViews.set("project-b", [subscriber]);
    subscriber.send.mockClear();
    sink(payload);
    expect(subscriber.send).not.toHaveBeenCalled();
    expect(sibling.send).not.toHaveBeenCalled();
  });

  it("reselects in the sender's project only", async () => {
    const all = await ops();
    const request = { sessionId: "s1", elementId: "el-1", reveal: true };
    await expect(all.reselect.handler(ctx("project-a"), request)).resolves.toBe(true);
    expect(bridge.reselectElementPicker).toHaveBeenCalledWith("project-a", "s1", request);
  });

  it("serves a workspace's source only to the view that opened it", async () => {
    const all = await ops();
    const opener = ctx("project-a", 1);
    const opened = await all.openWorkspace.handler(opener, {
      panelId: "panel-1",
      worktreeId: "wt-1",
    });
    expect(opened).toMatchObject({ status: "ready", workspaceId: "ws-1", appPath: "." });
    expect(host.registerWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: root, appRoot: root })
    );

    const request = { workspaceId: "ws-1", requestId: "r1" } as never;
    const closed = { code: "NOT_FOUND", message: ELEMENT_PICKER_WORKSPACE_CLOSED };
    await expect(all.resolve.handler(ctx("project-a", 2), request)).rejects.toMatchObject(closed);
    await expect(all.resolve.handler(ctx("project-b", 1), request)).rejects.toMatchObject(closed);
    await expect(
      all.sourceRevisions.handler(ctx("project-a", 2), { workspaceId: "ws-1", paths: ["a"] })
    ).rejects.toMatchObject(closed);
    expect(host.resolve).not.toHaveBeenCalled();
    expect(host.sourceRevisions).not.toHaveBeenCalled();

    await expect(all.resolve.handler(opener, request)).resolves.toMatchObject({
      requestId: "r1",
    });
    expect(host.resolve).toHaveBeenCalledWith(request);
  });

  it("refuses a worktree of another project", async () => {
    store.projects.set("project-b", { path: root, status: "active" });
    store.worktrees.set("project-b", []);
    const all = await ops();
    await expect(
      all.openWorkspace.handler(ctx("project-b"), { panelId: "panel-1", worktreeId: "wt-1" })
    ).resolves.toEqual({ status: "unavailable", reason: "unknown-worktree" });
    expect(host.registerWorkspace).not.toHaveBeenCalled();
  });

  it("answers the host's failures in the view's terms", async () => {
    const all = await ops();
    // The module the service was loaded with, after this test's module reset.
    const { ElementPickerHostError } = await import("../../../services/elementPicker/errors.js");
    const opener = ctx("project-a", 1);
    await all.openWorkspace.handler(opener, { panelId: "panel-1", worktreeId: "wt-1" });
    const request = { workspaceId: "ws-1" } as never;

    host.resolve.mockRejectedValueOnce(new ElementPickerHostError("INVALID_REQUEST", "bad"));
    await expect(all.resolve.handler(opener, request)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    host.resolve.mockRejectedValueOnce(new ElementPickerHostError("HOST_DISPOSED", "gone"));
    await expect(all.resolve.handler(opener, request)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    host.resolve.mockRejectedValueOnce(
      new ElementPickerHostError("RESOLVER_FAILED", "a resolver threw")
    );
    await expect(all.resolve.handler(opener, request)).rejects.toMatchObject({
      code: "INTERNAL",
      message: "A resolver threw",
    });
    host.resolve.mockRejectedValueOnce(new ElementPickerHostError("UNKNOWN_WORKSPACE", "gone"));
    await expect(all.resolve.handler(opener, request)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: ELEMENT_PICKER_WORKSPACE_CLOSED,
    });
  });

  it("closes only the caller's own workspace", async () => {
    const all = await ops();
    const opener = ctx("project-a", 1);
    await expect(all.closeWorkspace.handler(opener, { workspaceId: "ws-1" })).resolves.toEqual({
      closed: false,
    });
    await all.openWorkspace.handler(opener, { panelId: "panel-1", worktreeId: "wt-1" });
    await expect(
      all.closeWorkspace.handler(ctx("project-a", 2), { workspaceId: "ws-1" })
    ).resolves.toEqual({ closed: false });
    await expect(all.closeWorkspace.handler(opener, { workspaceId: "ws-1" })).resolves.toEqual({
      closed: true,
    });
    await vi.waitFor(() => expect(host.releaseWorkspace).toHaveBeenCalledWith("ws-1"));
  });
});
