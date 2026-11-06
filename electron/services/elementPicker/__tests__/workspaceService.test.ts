import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  ElementPickerWorkspaceService,
  MAX_LEASES_PER_ENDPOINT,
  loopbackPreviewOrigin,
  type ElementPickerWorkspaceServiceDeps,
} from "../workspaceService.js";
import { ElementPickerHostError } from "../errors.js";
import type { RegisterWorkspaceOptions } from "../ElementPickerHost.js";
import type { ClientEndpoint, Disposable, HostFrame } from "../../../ipc/endpoint.js";
import { ELEMENT_PICKER_WORKSPACE_CLOSED } from "../../../../shared/types/ipc/elementPicker.js";
import type { ElementPickerWorkspaceOpenRequest } from "../../../../shared/types/ipc/elementPicker.js";

const PROJECT = "project-1";
const OTHER_PROJECT = "project-2";
const REVISION = `sha256:${"a".repeat(64)}`;

class FakeEndpoint implements ClientEndpoint {
  readonly kind = "local-view" as const;
  readonly clientId = "local";
  readonly endpointId: string;
  readonly sent: HostFrame[] = [];
  private closed = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly handle: number,
    public projectId: string | null = PROJECT
  ) {
    this.endpointId = `local:${handle}`;
  }

  send(frame: HostFrame): void {
    if (!this.closed) this.sent.push(frame);
  }
  request(): Promise<unknown> {
    return Promise.reject(new Error("unsupported"));
  }
  onClose(cb: () => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }
  isClosed(): boolean {
    return this.closed;
  }
  close(): void {
    this.closed = true;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

function fakeHost() {
  let next = 0;
  const registered = new Map<string, RegisterWorkspaceOptions>();
  const gate: { promise: Promise<void> | null } = { promise: null };
  const host = {
    registerWorkspace: vi.fn(async (options: RegisterWorkspaceOptions) => {
      if (gate.promise) await gate.promise;
      const id = `ws-${++next}`;
      registered.set(id, options);
      return id;
    }),
    releaseWorkspace: vi.fn((id: string) => registered.delete(id)),
    resolve: vi.fn(async (request: unknown) => ({
      requestId: (request as { requestId: string }).requestId,
      documentEpoch: 0,
      outcomes: [],
    })),
    describeProject: vi.fn(async () => ({ status: "none" as const })),
    sourceRevisions: vi.fn(async (_id: string, paths: readonly string[]) =>
      paths.map((p) => ({ path: p, revision: REVISION }))
    ),
    holdSources: vi.fn(async (_id: string, _paths: readonly string[]) => undefined),
  };
  return { host, registered, gate };
}

let root: string;
let worktrees: Record<string, string>;

function write(relative: string, content = ""): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const kit = (name: string) =>
  JSON.stringify({ name, devDependencies: { "@sveltejs/kit": "^2.0.0" } });

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picker-workspaces-")));
  // Three SvelteKit apps in a monorepo, a plain package beside them, and a
  // folder with no package of its own.
  write("multi/package.json", JSON.stringify({ name: "root", private: true }));
  write("multi/apps/site/package.json", kit("site"));
  write("multi/apps/docs/package.json", kit("docs"));
  write("multi/web/shop/package.json", kit("shop"));
  write("multi/packages/ui/package.json", JSON.stringify({ name: "ui" }));
  fs.mkdirSync(path.join(root, "multi/apps/site/src/routes"), { recursive: true });
  fs.mkdirSync(path.join(root, "multi/packages/ui/src"), { recursive: true });
  fs.mkdirSync(path.join(root, "multi/tools/scripts"), { recursive: true });
  write("multi/apps/site/package-lock.json", "{}");
  write("single/package.json", kit("single"));
  fs.mkdirSync(path.join(root, "single/src"), { recursive: true });
  write("none/README.md", "nothing here");
  fs.mkdirSync(path.join(root, "outside/app"), { recursive: true });
  worktrees = {
    "wt-multi": path.join(root, "multi"),
    "wt-single": path.join(root, "single"),
    "wt-none": path.join(root, "none"),
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function service(
  overrides: Partial<ElementPickerWorkspaceServiceDeps> & {
    project?: { path: string; status?: "active" | "closed" } | null;
  } = {}
) {
  const fake = fakeHost();
  const listWorktrees = vi.fn(async (_projectPath: string, projectId: string) =>
    projectId === PROJECT ? Object.entries(worktrees).map(([id, p]) => ({ id, path: p })) : null
  );
  const svc = new ElementPickerWorkspaceService({
    getProject: (projectId) =>
      overrides.project !== undefined
        ? overrides.project
        : projectId === PROJECT || projectId === OTHER_PROJECT
          ? { path: root, status: "active" }
          : null,
    listWorktrees,
    getHost: async () => fake.host,
    ...overrides,
  });
  return { svc, listWorktrees, ...fake };
}

function openRequest(
  over: Partial<ElementPickerWorkspaceOpenRequest> = {}
): ElementPickerWorkspaceOpenRequest {
  return { panelId: "panel-1", worktreeId: "wt-multi", ...over };
}

describe("ElementPickerWorkspaceService.open", () => {
  it("refuses a worktree that is not one of the sender's project's", async () => {
    const { svc, host } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    await expect(svc.open(owner, openRequest({ worktreeId: "wt-elsewhere" }))).resolves.toEqual({
      status: "unavailable",
      reason: "unknown-worktree",
    });
    // A project main has no worktree list for: the same answer.
    const other = { projectId: OTHER_PROJECT, endpoint: new FakeEndpoint(2, OTHER_PROJECT) };
    await expect(svc.open(other, openRequest())).resolves.toEqual({
      status: "unavailable",
      reason: "unknown-worktree",
    });
    expect(host.registerWorkspace).not.toHaveBeenCalled();
  });

  it("refuses a closed project and one main does not know", async () => {
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    for (const project of [{ path: root, status: "closed" as const }, null]) {
      const { svc, host, listWorktrees } = service({ project });
      await expect(svc.open(owner, openRequest())).resolves.toEqual({
        status: "unavailable",
        reason: "unknown-worktree",
      });
      expect(listWorktrees).not.toHaveBeenCalled();
      expect(host.registerWorkspace).not.toHaveBeenCalled();
    }
  });

  it("refuses a picked app outside the worktree, climbing out of it, or not a directory", async () => {
    const { svc, host } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    fs.symlinkSync(path.join(root, "outside/app"), path.join(root, "multi/apps/link"));
    for (const appPath of [
      "../outside/app",
      "apps/../../outside/app",
      "./apps/site",
      "apps/site/",
      path.join(root, "outside/app"),
      "/apps/site",
      "apps\\site",
      "apps/missing",
      "apps/site/package-lock.json",
      "apps/link",
    ]) {
      await expect(svc.open(owner, openRequest({ appPath })), appPath).resolves.toEqual({
        status: "unavailable",
        reason: "invalid-app",
      });
    }
    expect(host.registerWorkspace).not.toHaveBeenCalled();
  });

  it("opens the app the user picked, whatever the server's directory says", async () => {
    const { svc, registered } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    const picked = await svc.open(
      owner,
      openRequest({ appPath: "apps/docs", serverCwd: path.join(root, "multi/apps/site") })
    );
    expect(picked).toEqual({
      status: "ready",
      workspaceId: "ws-1",
      appPath: "apps/docs",
      appPaths: ["apps/docs", "apps/site", "web/shop"],
      scanComplete: true,
    });
    expect(registered.get("ws-1")).toMatchObject({
      worktreePath: path.join(root, "multi"),
      appRoot: path.join(root, "multi/apps/docs"),
    });

    await expect(svc.open(owner, openRequest({ appPath: "." }))).resolves.toMatchObject({
      status: "ready",
      appPath: ".",
    });
  });

  it.each([
    ["inside an app", "multi/apps/site/src/routes", "apps/site"],
    ["at an app's root", "multi/apps/site", "apps/site"],
    ["above exactly one app", "multi/web", "web/shop"],
    ["in a package beside the apps", "multi/packages/ui/src", "packages/ui"],
    ["in a folder with no package of its own", "multi/tools/scripts", "."],
  ])("chooses by where the server runs: %s", async (_label, cwd, appPath) => {
    const { svc } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    await expect(
      svc.open(owner, openRequest({ serverCwd: path.join(root, cwd) }))
    ).resolves.toMatchObject({ status: "ready", appPath });
  });

  it("asks the user when the server runs above more than one app", async () => {
    const { svc, host } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    await expect(
      svc.open(owner, openRequest({ serverCwd: path.join(root, "multi/apps") }))
    ).resolves.toEqual({
      status: "ambiguous",
      appPaths: ["apps/docs", "apps/site"],
      scanComplete: true,
    });
    expect(host.registerWorkspace).not.toHaveBeenCalled();
  });

  it("chooses the innermost of nested apps holding the server's directory", async () => {
    write("multi/apps/site/examples/demo/package.json", kit("demo"));
    const { svc } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    await expect(
      svc.open(owner, openRequest({ serverCwd: path.join(root, "multi/apps/site/examples/demo") }))
    ).resolves.toMatchObject({ status: "ready", appPath: "apps/site/examples/demo" });
  });

  it("chooses with no server directory: the only app, the user, or the worktree", async () => {
    const { svc } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    await expect(svc.open(owner, openRequest({ worktreeId: "wt-single" }))).resolves.toEqual({
      status: "ready",
      workspaceId: "ws-1",
      appPath: ".",
      appPaths: ["."],
      scanComplete: true,
    });
    await expect(svc.open(owner, openRequest())).resolves.toEqual({
      status: "ambiguous",
      appPaths: ["apps/docs", "apps/site", "web/shop"],
      scanComplete: true,
    });
    await expect(svc.open(owner, openRequest({ worktreeId: "wt-none" }))).resolves.toEqual({
      status: "ready",
      workspaceId: "ws-2",
      appPath: ".",
      appPaths: [],
      scanComplete: true,
    });
  });

  it("ignores a server directory outside the worktree rather than trusting it", async () => {
    const { svc } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    for (const serverCwd of [path.join(root, "outside/app"), "apps/site", "/nonexistent/dir"]) {
      await expect(
        svc.open(owner, openRequest({ worktreeId: "wt-single", serverCwd }))
      ).resolves.toMatchObject({ status: "ready", appPath: "." });
    }
  });

  it("says when the search for apps stopped short", async () => {
    const { svc } = service({
      discoverApps: async (worktreeRoot) => ({
        appRoots: [path.join(worktreeRoot, "apps/site")],
        complete: false,
      }),
    });
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    await expect(svc.open(owner, openRequest())).resolves.toMatchObject({
      status: "ready",
      appPath: "apps/site",
      scanComplete: false,
    });
  });

  it("keeps an app the search reported outside the worktree out of every answer", async () => {
    const { svc } = service({
      discoverApps: async (worktreeRoot) => ({
        appRoots: [path.join(root, "outside/app"), path.join(worktreeRoot, "apps/site")],
        complete: true,
      }),
    });
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    await expect(svc.open(owner, openRequest())).resolves.toMatchObject({
      status: "ready",
      appPath: "apps/site",
      appPaths: ["apps/site"],
    });
  });

  it("hands the host the preview's origin only when it is this machine's own server", async () => {
    const { svc, registered } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    const origins: Array<[string, string | undefined]> = [
      ["http://localhost:5173/some/page?q=1", "http://localhost:5173"],
      ["https://app.localhost:8443", "https://app.localhost:8443"],
      ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
      ["http://127.1.2.3:3000", "http://127.1.2.3:3000"],
      ["http://[::1]:8080", "http://[::1]:8080"],
      ["http://example.com:5173", undefined],
      ["http://localhost.example.com", undefined],
      ["http://192.168.1.4:5173", undefined],
      ["http://user:pw@localhost:5173", undefined],
      ["file:///srv/app", undefined],
      ["ftp://localhost", undefined],
      ["not a url", undefined],
    ];
    for (const [previewOrigin, expected] of origins) {
      const opened = await svc.open(owner, openRequest({ worktreeId: "wt-single", previewOrigin }));
      if (opened.status !== "ready") throw new Error("expected a workspace");
      expect(registered.get(opened.workspaceId)?.previewOrigin, previewOrigin).toBe(expected);
      expect(loopbackPreviewOrigin(previewOrigin)).toBe(expected);
    }
  });
});

describe("ElementPickerWorkspaceService leases", () => {
  async function opened() {
    const harness = service();
    const endpoint = new FakeEndpoint(1);
    const owner = { projectId: PROJECT, endpoint };
    const result = await harness.svc.open(owner, openRequest({ worktreeId: "wt-single" }));
    if (result.status !== "ready") throw new Error("expected a workspace");
    return { ...harness, endpoint, owner, workspaceId: result.workspaceId };
  }

  it("serves a workspace only to the view and project that opened it", async () => {
    const { svc, host, owner, workspaceId } = await opened();
    const otherView = { projectId: PROJECT, endpoint: new FakeEndpoint(2) };
    const otherProject = { projectId: OTHER_PROJECT, endpoint: owner.endpoint };
    const closed = { code: "NOT_FOUND", message: ELEMENT_PICKER_WORKSPACE_CLOSED };

    for (const stranger of [otherView, otherProject]) {
      expect(() => svc.get(stranger, workspaceId)).toThrow(
        expect.objectContaining(closed) as Error
      );
      await expect(
        svc.resolve(stranger, { workspaceId } as { workspaceId: string })
      ).rejects.toMatchObject(closed);
      await expect(
        svc.describeProject(stranger, workspaceId, "http://localhost/")
      ).rejects.toMatchObject(closed);
      await expect(
        svc.sourceRevisions(stranger, workspaceId, ["src/a.svelte"])
      ).rejects.toMatchObject(closed);
      await expect(svc.holdSources(stranger, workspaceId, ["src/a.svelte"])).rejects.toMatchObject(
        closed
      );
      expect(svc.close(stranger, workspaceId)).toEqual({ closed: false });
    }
    expect(host.resolve).not.toHaveBeenCalled();
    expect(host.describeProject).not.toHaveBeenCalled();
    expect(host.sourceRevisions).not.toHaveBeenCalled();
    expect(host.holdSources).not.toHaveBeenCalled();
    expect(host.releaseWorkspace).not.toHaveBeenCalled();

    expect(svc.get(owner, workspaceId)).toMatchObject({
      workspaceId,
      projectId: PROJECT,
      panelId: "panel-1",
      worktreeId: "wt-single",
    });
    await expect(svc.sourceRevisions(owner, workspaceId, ["src/a.svelte"])).resolves.toEqual({
      revisions: [{ path: "src/a.svelte", revision: REVISION }],
    });
    await expect(
      svc.holdSources(owner, workspaceId, ["src/b.svelte", "src/a.svelte"])
    ).resolves.toBeUndefined();
    expect(host.holdSources).toHaveBeenCalledWith(workspaceId, ["src/b.svelte", "src/a.svelte"]);
  });

  it("closes a workspace for its owner, after which it reads as closed", async () => {
    const { svc, host, owner, workspaceId } = await opened();
    expect(svc.close(owner, workspaceId)).toEqual({ closed: true });
    await vi.waitFor(() => expect(host.releaseWorkspace).toHaveBeenCalledWith(workspaceId));
    expect(() => svc.get(owner, workspaceId)).toThrow(ELEMENT_PICKER_WORKSPACE_CLOSED);
    expect(svc.close(owner, workspaceId)).toEqual({ closed: false });
    expect(svc.close(owner, "never-opened")).toEqual({ closed: false });
  });

  it("releases every workspace a view held when it goes, and no other view's", async () => {
    const { svc, host, endpoint, owner, workspaceId } = await opened();
    const second = await svc.open(owner, openRequest({ worktreeId: "wt-none" }));
    const otherOwner = { projectId: PROJECT, endpoint: new FakeEndpoint(2) };
    const other = await svc.open(otherOwner, openRequest({ worktreeId: "wt-single" }));
    if (second.status !== "ready" || other.status !== "ready") throw new Error("expected ready");

    endpoint.close();

    await vi.waitFor(() => expect(host.releaseWorkspace).toHaveBeenCalledTimes(2));
    expect(host.releaseWorkspace.mock.calls.map(([id]) => id).sort()).toEqual(
      [workspaceId, second.workspaceId].sort()
    );
    expect(svc.get(otherOwner, other.workspaceId).workspaceId).toBe(other.workspaceId);
  });

  it("stops listening for a view's close once it holds nothing", async () => {
    const { svc, endpoint, owner, workspaceId } = await opened();
    expect(endpoint.listenerCount).toBe(1);
    svc.close(owner, workspaceId);
    expect(endpoint.listenerCount).toBe(0);
  });

  it("releases a workspace the host finished opening after its view went", async () => {
    const { svc, host, gate } = service();
    const endpoint = new FakeEndpoint(1);
    let open!: () => void;
    gate.promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    const pending = svc.open(
      { projectId: PROJECT, endpoint },
      openRequest({ worktreeId: "wt-single" })
    );
    await vi.waitFor(() => expect(host.registerWorkspace).toHaveBeenCalled());
    endpoint.close();
    open();

    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(host.releaseWorkspace).toHaveBeenCalledWith("ws-1");
    expect(endpoint.listenerCount).toBe(0);
  });

  it("opens nothing for a view that has already gone", async () => {
    const { svc, host } = service();
    const endpoint = new FakeEndpoint(1);
    endpoint.close();
    await expect(svc.open({ projectId: PROJECT, endpoint }, openRequest())).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(host.registerWorkspace).not.toHaveBeenCalled();
  });

  it("lets one view hold only so many workspaces, giving up its oldest first", async () => {
    const { svc, host } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    const ids: string[] = [];
    for (let index = 0; index <= MAX_LEASES_PER_ENDPOINT; index += 1) {
      const result = await svc.open(owner, openRequest({ worktreeId: "wt-single" }));
      if (result.status !== "ready") throw new Error("expected ready");
      ids.push(result.workspaceId);
    }
    await vi.waitFor(() => expect(host.releaseWorkspace).toHaveBeenCalledWith(ids[0]));
    expect(() => svc.get(owner, ids[0]!)).toThrow(ELEMENT_PICKER_WORKSPACE_CLOSED);
    expect(svc.get(owner, ids.at(-1)!).workspaceId).toBe(ids.at(-1));
    // Room is made before the new one enters the shared registry, which would
    // otherwise evict some other view's workspace to fit it.
    const released = host.releaseWorkspace.mock.invocationCallOrder[0]!;
    const lastRegistered = host.registerWorkspace.mock.invocationCallOrder.at(-1)!;
    expect(released).toBeLessThan(lastRegistered);
  });

  it("never holds more for one view than its share, however many opens it races", async () => {
    const { svc, host, registered } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    for (let index = 0; index < MAX_LEASES_PER_ENDPOINT; index += 1) {
      await svc.open(owner, openRequest({ worktreeId: "wt-single" }));
    }
    // The host's registry is shared: what matters is the most it ever held,
    // since one past its bound evicts some other view's workspace.
    let most = registered.size;
    const register = host.registerWorkspace.getMockImplementation()!;
    host.registerWorkspace.mockImplementation(async (options) => {
      const id = await register(options);
      most = Math.max(most, registered.size);
      return id;
    });
    // Two at once from a full view: each must make its own room first.
    await Promise.all([
      svc.open(owner, openRequest({ worktreeId: "wt-single" })),
      svc.open(owner, openRequest({ worktreeId: "wt-single" })),
    ]);
    expect(most).toBe(MAX_LEASES_PER_ENDPOINT);
  });

  it("says a workspace released while its resolve was out is closed, not cancelled", async () => {
    const { svc, host, owner, workspaceId } = await opened();
    let answer: ((value: unknown) => void) | undefined;
    host.resolve.mockImplementationOnce(
      (request: unknown) =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              requestId: (request as { requestId: string }).requestId,
              documentEpoch: 0,
              outcomes: [],
            });
        })
    );
    const resolving = svc.resolve(owner, { workspaceId });
    await vi.waitFor(() => expect(answer).toBeDefined());
    svc.close(owner, workspaceId);
    answer?.(undefined);
    await expect(resolving).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: ELEMENT_PICKER_WORKSPACE_CLOSED,
    });
  });

  it("pushes a source change to the view that holds the workspace, and only while it does", async () => {
    const { svc, registered, endpoint, owner, workspaceId } = await opened();
    const bystander = new FakeEndpoint(2);
    const change = {
      file: { workspaceId, path: "src/App.svelte" },
      revision: REVISION as `sha256:${string}`,
    };
    const onSourceChanged = registered.get(workspaceId)!.onSourceChanged;

    onSourceChanged(change);
    expect(endpoint.sent).toEqual([
      {
        type: "event",
        channel: "element-picker:source-changed",
        args: [{ workspaceId, panelId: "panel-1", ...change }],
      },
    ]);
    expect(bystander.sent).toEqual([]);

    // A view now showing another project hears nothing of this one's source.
    endpoint.projectId = OTHER_PROJECT;
    onSourceChanged(change);
    endpoint.projectId = PROJECT;
    svc.close(owner, workspaceId);
    onSourceChanged(change);
    expect(endpoint.sent).toHaveLength(1);
  });

  it("disposes every lease and opens nothing after", async () => {
    const { svc, host, owner, workspaceId } = await opened();
    await svc.disposeAll();
    await vi.waitFor(() => expect(host.releaseWorkspace).toHaveBeenCalledWith(workspaceId));
    await expect(svc.open(owner, openRequest())).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("ElementPickerWorkspaceService host errors", () => {
  it.each([
    ["UNKNOWN_WORKSPACE", "NOT_FOUND", ELEMENT_PICKER_WORKSPACE_CLOSED],
    ["INVALID_REQUEST", "VALIDATION", "The request is malformed"],
    ["HOST_DISPOSED", "CANCELLED", "The request is malformed"],
    ["HOST_CRASHED", "INTERNAL", "The request is malformed"],
    ["HOST_BUSY", "INTERNAL", "The request is malformed"],
  ] as const)("answers a host's %s as %s", async (hostCode, code, message) => {
    const { svc, host } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    const result = await svc.open(owner, openRequest({ worktreeId: "wt-single" }));
    if (result.status !== "ready") throw new Error("expected ready");
    host.resolve.mockRejectedValueOnce(
      new ElementPickerHostError(hostCode, "the request is malformed")
    );
    await expect(
      svc.resolve(owner, { workspaceId: result.workspaceId } as { workspaceId: string })
    ).rejects.toMatchObject({ code, message });
    // Only a host that no longer holds the workspace ends the lease.
    if (hostCode === "UNKNOWN_WORKSPACE") {
      expect(() => svc.get(owner, result.workspaceId)).toThrow(ELEMENT_PICKER_WORKSPACE_CLOSED);
    } else {
      expect(svc.get(owner, result.workspaceId).workspaceId).toBe(result.workspaceId);
    }
  });

  it("answers a workspace the host no longer describes as closed", async () => {
    const { svc, host } = service();
    const owner = { projectId: PROJECT, endpoint: new FakeEndpoint(1) };
    const result = await svc.open(owner, openRequest({ worktreeId: "wt-single" }));
    if (result.status !== "ready") throw new Error("expected ready");
    host.describeProject.mockResolvedValueOnce({
      status: "unavailable",
      reason: "unknown-workspace",
    } as never);
    await expect(
      svc.describeProject(owner, result.workspaceId, "http://localhost/")
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: ELEMENT_PICKER_WORKSPACE_CLOSED });
    expect(() => svc.get(owner, result.workspaceId)).toThrow(ELEMENT_PICKER_WORKSPACE_CLOSED);
  });

  it("answers a host that could not open the workspace in the view's terms", async () => {
    const { svc, host } = service();
    host.registerWorkspace.mockRejectedValueOnce(
      new ElementPickerHostError(
        "INVALID_REQUEST",
        "the workspace roots are not readable directories"
      )
    );
    await expect(
      svc.open(
        { projectId: PROJECT, endpoint: new FakeEndpoint(1) },
        openRequest({ worktreeId: "wt-single" })
      )
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "The workspace roots are not readable directories",
    });
  });
});
