// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { TerminalRecord } from "../../driveLeaseTargets.js";

const { owners } = vi.hoisted(() => ({
  owners: {
    projectsForPath: (_p: string): readonly string[] | Promise<readonly string[]> => [],
    describeTerminal: (_id: string): TerminalRecord | Promise<TerminalRecord> => "missing",
  },
}));

// The factory module reaches Electron's `app` on import through the settings
// manager; nothing under test here touches it.
vi.mock("electron", () => ({
  app: { getPath: (key: string) => `/mock/electron/${key}`, getVersion: () => "0.0.0" },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [], fromId: () => null },
  clipboard: {},
  shell: {},
}));

// Which project a path belongs to is the lease gate's own lookup; here a test
// says it outright.
vi.mock("../../driveLeaseTargetResolvers.js", () => ({
  createLeaseTargetResolvers: () => ({
    projectsForPath: (p: string) => owners.projectsForPath(p),
    describeTerminal: (id: string) => owners.describeTerminal(id),
    projectsForOperation: () => [],
    projectsForDevPreviewPanel: () => [],
    projectsForHelpSession: () => [],
    currentProjectId: () => null,
  }),
}));

import { buildFsApi } from "../PluginHostFactory.js";
import { assertPluginCallerDrives } from "../pluginDriveLease.js";
import type { PluginHostFactoryDeps } from "../PluginHostFactory.js";
import {
  _resetPluginFrontendRoutingForTesting,
  runInPluginInvocation,
  runWithEndedPluginInvocation,
  setPluginFrontendRouter,
} from "../pluginFrontendRouting.js";
import {
  _resetDriveLeaseServiceForTesting,
  type DriveLeaseService,
} from "../../DriveLeaseService.js";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import type { DriveLeaseHolder } from "../../../../shared/types/remoteHosts.js";

/**
 * A plugin's write into a project, made inside a call from a window, is held
 * to that window's drive lease exactly as the window's own project writes are:
 * a view that watches can read the project through the plugin but not change
 * it (#13920).
 */
const PLUGIN_ID = "lease-fs-test";

function endpoint(endpointId: string, clientId: string): ClientEndpoint {
  return {
    endpointId,
    clientId,
    projectId: "p1",
    kind: "remote-view",
    handle: -1,
    send: vi.fn(),
    request: vi.fn(),
    onClose: () => ({ dispose: () => undefined }),
    isClosed: () => false,
  };
}

const HOLDER = endpoint("remote:-9", "client-c");
const WATCHER = endpoint("remote:-4", "client-b");

function holder(of: ClientEndpoint): DriveLeaseHolder {
  return {
    leaseId: 1,
    endpointId: of.endpointId,
    clientId: of.clientId,
    clientName: "greg-mbp",
    isHostLocal: false,
    acquiredAt: 0,
  };
}

/** A lease table the tests set directly: projectId → the endpoint that holds it. */
function installLeases(leases: Map<string, ClientEndpoint>): void {
  const service = {
    projectsDrivenElsewhere: (caller: Pick<ClientEndpoint, "endpointId">) => {
      const out = new Map<string, DriveLeaseHolder>();
      for (const [projectId, by] of leases) {
        if (by.endpointId !== caller.endpointId) out.set(projectId, holder(by));
      }
      return out;
    },
    dispose: () => undefined,
  };
  _resetDriveLeaseServiceForTesting(service as unknown as DriveLeaseService);
}

function depsFor(projectRoot: string, dataDir: string): PluginHostFactoryDeps {
  return {
    plugins: new Map([[PLUGIN_ID, { isBuiltin: true }]]),
    declaredCapabilities: () =>
      new Set(["fs:project-read", "fs:project-write", "fs:user-data-read", "fs:user-data-write"]),
    expandAllowedPathEntries: async () => [
      { path: dataDir, rootClass: "user-data" },
      { path: projectRoot, rootClass: "project" },
    ],
    pluginDataDir: () => dataDir,
    isPathUnder: (parent: string, child: string) =>
      child === parent || child.startsWith(parent + path.sep),
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "",
  } as unknown as PluginHostFactoryDeps;
}

describe("plugin writes from a view that doesn't drive the project", () => {
  let projectRoot: string;
  let dataDir: string;
  let target: string;

  beforeEach(async () => {
    projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lease-project-")));
    dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lease-data-")));
    target = path.join(projectRoot, "notes.md");
    await fs.writeFile(target, "original");
    owners.projectsForPath = (p) => (p.startsWith(projectRoot) ? ["p1"] : []);
    setPluginFrontendRouter({ resolve: () => ({ kind: "local" }), onChange: () => () => {} });
  });

  afterEach(async () => {
    _resetPluginFrontendRoutingForTesting();
    _resetDriveLeaseServiceForTesting(null);
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const api = () => buildFsApi(depsFor(projectRoot, dataDir), PLUGIN_ID);
  const asCaller = <T>(caller: ClientEndpoint, fn: () => Promise<T>) =>
    runInPluginInvocation(PLUGIN_ID, caller, fn);

  it("refuses a save with the Take control wording and leaves the file as it was", async () => {
    installLeases(new Map([["p1", HOLDER]]));

    const refused = asCaller(WATCHER, () => api().writeFile(target, "edited"));

    await expect(refused).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
      userMessage: "greg-mbp has control of this project. Take control first.",
    });
    await expect(refused).rejects.toThrow(/^DRIVEN_ELSEWHERE: .*Take control first\.$/);
    expect(await fs.readFile(target, "utf-8")).toBe("original");
  });

  it("refuses creating or appending inside the project too, and creates nothing", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    const fresh = path.join(projectRoot, "fresh");

    await expect(asCaller(WATCHER, () => api().mkdir(fresh))).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
    await expect(asCaller(WATCHER, () => api().appendFile(target, "+"))).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
    await expect(fs.stat(fresh)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(target, "utf-8")).toBe("original");
  });

  it("still reads the project for the view that watches", async () => {
    installLeases(new Map([["p1", HOLDER]]));

    await expect(asCaller(WATCHER, () => api().readFile(target))).resolves.toBe("original");
  });

  it("lets the view that drives save", async () => {
    installLeases(new Map([["p1", HOLDER]]));

    await asCaller(HOLDER, () => api().writeFile(target, "edited"));

    expect(await fs.readFile(target, "utf-8")).toBe("edited");
  });

  it("lets a watcher write the plugin's own data, which is in no project", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    const draft = path.join(dataDir, "drafts", "notes.json");

    await asCaller(WATCHER, () => api().writeFile(draft, "{}"));

    expect(await fs.readFile(draft, "utf-8")).toBe("{}");
  });

  it("refuses a write through a link in the plugin's data dir that leads into the project", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    await fs.symlink(projectRoot, path.join(dataDir, "into-project"));

    await expect(
      asCaller(WATCHER, () => api().writeFile(path.join(dataDir, "into-project", "notes.md"), "x"))
    ).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    expect(await fs.readFile(target, "utf-8")).toBe("original");
  });

  it("leaves a write that belongs to no call, and one with no lease service, as they were", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    await api().writeFile(target, "background");
    expect(await fs.readFile(target, "utf-8")).toBe("background");

    _resetDriveLeaseServiceForTesting(null);
    await asCaller(WATCHER, () => api().writeFile(target, "no lease"));
    expect(await fs.readFile(target, "utf-8")).toBe("no lease");
  });

  it("refuses a write when another screen takes the project while it waits", async () => {
    // Another project is driven elsewhere, so every check looks the path up.
    const leases = new Map<string, ClientEndpoint>([
      ["p1", WATCHER],
      ["p2", HOLDER],
    ]);
    installLeases(leases);
    let lookups = 0;
    owners.projectsForPath = (p) => {
      if (!p.startsWith(projectRoot)) return [];
      lookups += 1;
      // The gate's check passes; the takeover lands before the write's own
      // check, made once it holds the path, right before the bytes land.
      if (lookups === 2) leases.set("p1", HOLDER);
      return ["p1"];
    };

    await expect(asCaller(WATCHER, () => api().writeFile(target, "late"))).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
    expect(lookups).toBe(2);
    expect(await fs.readFile(target, "utf-8")).toBe("original");
  });

  it("refuses when it can't tell which project a path belongs to", async () => {
    installLeases(new Map([["p2", HOLDER]]));
    owners.projectsForPath = () => Promise.reject(new Error("lookup timed out"));

    await expect(asCaller(WATCHER, () => api().writeFile(target, "edited"))).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
    expect(await fs.readFile(target, "utf-8")).toBe("original");
  });
});

describe("assertPluginCallerDrives", () => {
  beforeEach(() => {
    setPluginFrontendRouter({ resolve: () => ({ kind: "local" }), onChange: () => () => {} });
    owners.describeTerminal = (id) =>
      id === "t1"
        ? { projectId: "p1" }
        : id === "t2"
          ? { projectId: "p2" }
          : id === "unowned"
            ? { projectId: null }
            : "missing";
  });

  afterEach(() => {
    _resetPluginFrontendRoutingForTesting();
    _resetDriveLeaseServiceForTesting(null);
  });

  const check = (caller: ClientEndpoint, terminalId: string) =>
    runInPluginInvocation(PLUGIN_ID, caller, () =>
      assertPluginCallerDrives(PLUGIN_ID, "sendToActiveAgent", { terminalId })
    );

  it("holds typing into an agent to the lease of the terminal's own project", async () => {
    installLeases(new Map([["p2", HOLDER]]));

    await expect(check(WATCHER, "t1")).resolves.toBeUndefined();
    await expect(check(WATCHER, "t2")).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    await expect(check(HOLDER, "t2")).resolves.toBeUndefined();
  });

  it("refuses a terminal it can't place while another screen drives a project here", async () => {
    installLeases(new Map([["p2", HOLDER]]));
    const unmatched = {
      code: "DRIVEN_ELSEWHERE",
      userMessage: expect.stringMatching(/couldn't be matched to a project\. Take control first\./),
    };

    // One the host confirms it doesn't have, and one it has with no project.
    await expect(check(WATCHER, "gone")).rejects.toMatchObject(unmatched);
    await expect(check(WATCHER, "unowned")).rejects.toMatchObject(unmatched);
  });

  it("refuses when the terminal lookup fails rather than letting the typing through", async () => {
    installLeases(new Map([["p2", HOLDER]]));
    owners.describeTerminal = () => Promise.reject(new Error("pty-host timed out"));

    await expect(check(WATCHER, "t1")).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
      userMessage: expect.stringMatching(/couldn't be matched to a project\. Take control first\./),
    });
  });

  it("looks nothing up while nobody else drives a project here", async () => {
    installLeases(new Map([["p1", WATCHER]]));
    owners.describeTerminal = () => {
      throw new Error("looked up");
    };

    await expect(check(WATCHER, "t1")).resolves.toBeUndefined();
  });
});

describe("plugin work that outlived the call that started it (#14251)", () => {
  const write = () => assertPluginCallerDrives(PLUGIN_ID, "fs.writeFile", { paths: ["/repo/a"] });
  const asEnded = (caller: ClientEndpoint | null, fn: () => Promise<void>) =>
    runWithEndedPluginInvocation({ pluginId: PLUGIN_ID, caller }, fn);

  beforeEach(() => {
    owners.projectsForPath = (p) => (p.startsWith("/repo/") ? ["p1"] : []);
  });

  afterEach(() => _resetDriveLeaseServiceForTesting(null));

  it("is held to the lease as the caller who made the call", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    await expect(asEnded(WATCHER, write)).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    await expect(asEnded(HOLDER, write)).resolves.toBeUndefined();
  });

  it("drives nothing when the host can't say who made the call", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    await expect(asEnded(null, write)).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    installLeases(new Map());
    await expect(asEnded(null, write)).resolves.toBeUndefined();
  });

  it("checks nothing without a lease service", async () => {
    await expect(asEnded(null, write)).resolves.toBeUndefined();
  });

  it("belongs only to the plugin whose call it was", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    await expect(
      runWithEndedPluginInvocation({ pluginId: "another.plugin", caller: null }, write)
    ).resolves.toBeUndefined();
  });

  it("yields to a live call it runs inside", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    setPluginFrontendRouter({ resolve: () => ({ kind: "local" }), onChange: () => () => {} });
    try {
      await expect(
        asEnded(WATCHER, () => runInPluginInvocation(PLUGIN_ID, HOLDER, write))
      ).resolves.toBeUndefined();
    } finally {
      _resetPluginFrontendRoutingForTesting();
    }
  });
});
