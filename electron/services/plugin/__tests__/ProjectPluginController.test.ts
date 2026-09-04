import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectPluginController } from "../ProjectPluginController.js";
import type { ProjectPluginControllerDeps } from "../ProjectPluginController.js";
import type {
  DiscoveredProjectPlugin,
  ProjectPluginDiscoveryResult,
} from "../projectPluginDiscovery.js";
import type { PluginManifest, ProjectPluginTrustRecord } from "../../../../shared/types/plugin.js";
import { makeProjectPluginInstanceKey } from "../../../../shared/types/plugin.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const ROOT_A = "/tmp/project-a";
const ROOT_B = "/tmp/project-b";

function manifestFor(name: string): Readonly<PluginManifest> {
  return {
    name,
    version: "1.0.0",
    scope: "project",
    capabilities: [],
    activationEvents: [],
    contributes: {
      actions: [],
      panels: [],
      views: [],
      toolbarButtons: [],
      menuItems: [],
      keybindings: [],
      contextMenus: [],
      commands: [],
      settings: [],
      mcpServers: [],
      forgeProviders: [],
      fileDecorationProviders: [],
      skills: [],
      agents: [],
      recipes: [],
      processTools: [],
    },
  } as unknown as Readonly<PluginManifest>;
}

function discovered(name: string, dirName = name.split(".")[1]!): DiscoveredProjectPlugin {
  return { dirName, dir: `/tmp/plugins/${dirName}`, manifest: manifestFor(name) };
}

interface Harness {
  controller: ProjectPluginController;
  deps: { [K in keyof ProjectPluginControllerDeps]: ReturnType<typeof vi.fn> };
  trust: Map<string, ProjectPluginTrustRecord>;
  setDiscovery: (projectRoot: string, plugins: DiscoveredProjectPlugin[]) => void;
  events: Array<{ projectId: string; name: string; payload: unknown }>;
}

function makeHarness(): Harness {
  const trust = new Map<string, ProjectPluginTrustRecord>();
  const byRoot = new Map<string, DiscoveredProjectPlugin[]>();
  const events: Harness["events"] = [];

  const deps = {
    discover: vi.fn(async (projectRoot: string): Promise<ProjectPluginDiscoveryResult> => ({
      root: `${projectRoot}/.daintree/plugins`,
      plugins: byRoot.get(projectRoot) ?? [],
    })),
    loadProjectPlugin: vi.fn(async () => true),
    unloadProjectPlugin: vi.fn(),
    purgeConsentForInstance: vi.fn(),
    listGlobalPluginIds: vi.fn(() => new Set<string>(["daintree.github"])),
    readTrust: vi.fn((projectId: string) => trust.get(projectId)),
    writeTrust: vi.fn((projectId: string, record?: ProjectPluginTrustRecord) => {
      if (record === undefined) trust.delete(projectId);
      else trust.set(projectId, record);
      return true;
    }),
    emitToProject: vi.fn((projectId: string, name: string, payload: unknown) => {
      events.push({ projectId, name, payload });
    }),
    isProjectClosed: vi.fn(() => false),
  };

  return {
    controller: new ProjectPluginController(deps as unknown as ProjectPluginControllerDeps),
    deps: deps as unknown as Harness["deps"],
    trust,
    setDiscovery: (projectRoot, plugins) => byRoot.set(projectRoot, plugins),
    events,
  };
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});

describe("trust gate", () => {
  it("runs nothing and prompts once when a project has plugins and no decision", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
    const prompts = h.events.filter((e) => e.name === "plugin:project-trust-prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.payload).toEqual({
      projectId: PROJECT_A,
      plugins: [{ id: "acme.dashboard", displayName: "acme.dashboard" }],
    });
    expect(h.deps.writeTrust).not.toHaveBeenCalled();
  });

  it("does not prompt when the folder has no plugins", async () => {
    h.setDiscovery(ROOT_A, []);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.events.some((e) => e.name === "plugin:project-trust-prompt")).toBe(false);
  });

  it("does not prompt when every manifest is invalid", async () => {
    h.setDiscovery(ROOT_A, [{ dirName: "broken", dir: "/tmp/x", error: "bad JSON" }]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.events.some((e) => e.name === "plugin:project-trust-prompt")).toBe(false);
    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
  });

  it("remembers a keep-disabled decision and never prompts again", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "disabled");

    expect(h.trust.get(PROJECT_A)?.decision).toBe("disabled");

    await h.controller.onProjectClosed(PROJECT_A);
    h.events.length = 0;
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(h.events.some((e) => e.name === "plugin:project-trust-prompt")).toBe(false);
    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
  });

  it("activates everything the prompt listed when the user always-enables", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.deploy")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");

    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(2);
    const record = h.trust.get(PROJECT_A)!;
    expect(record.decision).toBe("enabled");
    expect(record.knownPluginIds.sort()).toEqual(["acme.dashboard", "acme.deploy"]);
    expect(record.stagedPluginIds).toEqual([]);
  });

  it("never writes a session grant", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "session");

    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);
    expect(h.deps.writeTrust).not.toHaveBeenCalled();
    expect(h.trust.has(PROJECT_A)).toBe(false);
  });

  it("a session grant does not survive a close", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "session");
    await h.controller.onProjectClosed(PROJECT_A);

    h.deps.loadProjectPlugin.mockClear();
    h.events.length = 0;
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
    expect(h.events.some((e) => e.name === "plugin:project-trust-prompt")).toBe(true);
  });
});

describe("persistence failures are loud (#12212)", () => {
  it("rejects the decision when the trust record did not reach disk", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    h.deps.writeTrust.mockReturnValue(false);

    await expect(h.controller.setTrust(PROJECT_A, "enabled")).rejects.toThrow(/settings file/i);
  });

  it("still applies the decision it could not persist", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    h.deps.writeTrust.mockReturnValue(false);

    await expect(h.controller.setTrust(PROJECT_A, "enabled")).rejects.toThrow();

    // The grant is real for this session — refusing to run what the user just
    // said yes to would be a second failure on top of the first.
    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);
    // But it must not claim to be remembered, or nothing would re-offer it.
    expect(h.controller.getTrustState(PROJECT_A)).toMatchObject({
      decision: "enabled",
      enabled: true,
      persisted: false,
    });
  });

  it("reports a failed revoke too, after unloading", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");
    h.deps.writeTrust.mockReturnValue(false);

    await expect(h.controller.setTrust(PROJECT_A, "disabled")).rejects.toThrow(/settings file/i);
    expect(h.deps.unloadProjectPlugin).toHaveBeenCalled();
  });

  it("refuses a decision for a project it holds no state for, rather than dropping it", async () => {
    // Silently returning here let the renderer report a decision as saved that
    // was never recorded anywhere.
    await expect(h.controller.setTrust(PROJECT_A, "enabled")).rejects.toThrow(
      /reopen the project/i
    );
    expect(h.deps.writeTrust).not.toHaveBeenCalled();
  });

  it("a session grant is not a failed write", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    h.deps.writeTrust.mockReturnValue(false);

    // Nothing was meant to be written, so there is nothing to report.
    await expect(h.controller.setTrust(PROJECT_A, "session")).resolves.toBeUndefined();
    expect(h.deps.writeTrust).not.toHaveBeenCalled();
  });
});

describe("watching an undecided project (#12212)", () => {
  it("reaches the prompt from a watcher edge, with no project switch", async () => {
    // The folder was empty when the project opened, so there was nothing to
    // consent to and no decision was recorded.
    h.setDiscovery(ROOT_A, []);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.events.some((e) => e.name === "plugin:project-trust-prompt")).toBe(false);

    // An agent writes the first plugin into it. The watcher's reload edge is
    // the only thing that can notice before the user switches projects.
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.reloadChanged(PROJECT_A, ROOT_A, []);

    expect(h.events.some((e) => e.name === "plugin:project-trust-prompt")).toBe(true);
    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
  });

  it("still refuses to reload into a project that answered no", async () => {
    h.trust.set(PROJECT_A, {
      decision: "disabled",
      decidedAt: 0,
      knownPluginIds: [],
      stagedPluginIds: [],
    });
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    h.events.length = 0;

    await h.controller.reloadChanged(PROJECT_A, ROOT_A, ["acme.dashboard"]);

    expect(h.events.some((e) => e.name === "plugin:project-trust-prompt")).toBe(false);
    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
  });
});

describe("content changes in a trusted project", () => {
  beforeEach(async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");
    h.deps.loadProjectPlugin.mockClear();
    h.events.length = 0;
  });

  it("reloads silently — no prompt, no staging — when an existing plugin changes", async () => {
    await h.controller.onProjectClosed(PROJECT_A);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);
    expect(h.events.some((e) => e.name === "plugin:project-trust-prompt")).toBe(false);
    expect(h.events.some((e) => e.name === "plugin:project-plugin-staged")).toBe(false);
  });

  it("stages a NEW manifest id rather than running it, and announces it once", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.newcomer")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalledWith(
      expect.objectContaining({ manifest: expect.objectContaining({ name: "acme.newcomer" }) })
    );
    const staged = h.events.filter((e) => e.name === "plugin:project-plugin-staged");
    expect(staged).toHaveLength(1);
    expect(staged[0]!.payload).toMatchObject({ pluginId: "acme.newcomer" });
    expect(h.trust.get(PROJECT_A)!.stagedPluginIds).toEqual(["acme.newcomer"]);

    // A second open does not re-notify: a declined stage stays declined.
    h.events.length = 0;
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.events.some((e) => e.name === "plugin:project-plugin-staged")).toBe(false);
  });

  it("activates a staged plugin on request and clears its staged flag", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.newcomer")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    h.deps.loadProjectPlugin.mockClear();

    await h.controller.activateStaged(PROJECT_A, "acme.newcomer");

    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);
    expect(h.trust.get(PROJECT_A)!.stagedPluginIds).toEqual([]);
    expect(
      h.controller.listProjectPlugins(PROJECT_A).find((p) => p.id === "acme.newcomer")!.state
    ).toBe("active");
  });

  it("treats a plugin that disappears and returns as known, not new", async () => {
    h.setDiscovery(ROOT_A, []);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(
      makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard")
    );

    h.events.length = 0;
    h.deps.loadProjectPlugin.mockClear();
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);
    expect(h.events.some((e) => e.name === "plugin:project-plugin-staged")).toBe(false);
  });
});

describe("revoke", () => {
  it("unloads every plugin and purges only this project's grants", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");

    await h.controller.setTrust(PROJECT_A, "disabled");

    const keyA = makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard");
    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(keyA);
    expect(h.deps.purgeConsentForInstance).toHaveBeenCalledWith(keyA);
    for (const call of h.deps.purgeConsentForInstance.mock.calls) {
      expect(String(call[0])).not.toContain(PROJECT_B);
    }
  });
});

describe("two projects with the same manifest id", () => {
  it("load under separate instance keys and unload independently", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    h.setDiscovery(ROOT_B, [discovered("acme.dashboard")]);

    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");
    await h.controller.onProjectOpened(PROJECT_B, ROOT_B);
    await h.controller.setTrust(PROJECT_B, "enabled");

    expect(
      h.deps.loadProjectPlugin.mock.calls.map((c) => (c[0] as { projectId: string }).projectId)
    ).toEqual([PROJECT_A, PROJECT_B]);

    await h.controller.onProjectClosed(PROJECT_A);

    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledTimes(1);
    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(
      makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard")
    );
  });

  it("keep separate trust records", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    h.setDiscovery(ROOT_B, [discovered("acme.dashboard")]);

    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");
    await h.controller.onProjectOpened(PROJECT_B, ROOT_B);

    expect(h.trust.get(PROJECT_B)).toBeUndefined();
    const prompts = h.events.filter(
      (e) => e.name === "plugin:project-trust-prompt" && e.projectId === PROJECT_B
    );
    expect(prompts).toHaveLength(1);
  });
});

describe("reconciliation", () => {
  it("unloads a project whose row went closed behind our back", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    h.setDiscovery(ROOT_B, []);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");

    h.deps.isProjectClosed.mockImplementation((id: string) => id === PROJECT_A);
    await h.controller.onProjectOpened(PROJECT_B, ROOT_B);

    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(
      makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard")
    );
  });

  it("does not treat a store read failure as closed", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    h.setDiscovery(ROOT_B, []);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");

    h.deps.isProjectClosed.mockReturnValue(false);
    await h.controller.onProjectOpened(PROJECT_B, ROOT_B);

    expect(h.deps.unloadProjectPlugin).not.toHaveBeenCalled();
  });
});

describe("listProjectPlugins", () => {
  it("surfaces an id collision with an installed plugin rather than hiding it", async () => {
    h.deps.listGlobalPluginIds.mockReturnValue(new Set(["acme.dashboard"]));
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    const rows = h.controller.listProjectPlugins(PROJECT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.collidesWithGlobal).toBe(true);
    expect(rows[0]!.state).toBe("blocked");
    expect(rows[0]!.instanceId).toBe(makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard"));
  });

  it("reports an unreadable directory as invalid with its reason", async () => {
    h.setDiscovery(ROOT_A, [{ dirName: "broken", dir: "/tmp/x", error: "bad JSON" }]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    const rows = h.controller.listProjectPlugins(PROJECT_A);
    expect(rows[0]).toMatchObject({ state: "invalid", error: "bad JSON", id: "broken" });
    expect(rows[0]!.instanceId).toBeUndefined();
  });
});

describe("dispose", () => {
  it("unloads every loaded instance", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");

    h.controller.dispose();

    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(
      makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard")
    );
    expect(h.controller.loadedInstanceKeys()).toEqual([]);
  });
});

describe("races", () => {
  it("unloads a plugin whose load landed after a revoke", async () => {
    let releaseLoad: (() => void) | undefined;
    h.deps.loadProjectPlugin.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseLoad = () => resolve(true);
        })
    );
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    const trusting = h.controller.setTrust(PROJECT_A, "enabled");
    await Promise.resolve();
    // Revoke lands while the load is still in flight.
    const revoking = h.controller.setTrust(PROJECT_A, "disabled");
    releaseLoad!();
    await trusting;
    await revoking;

    const key = makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard");
    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(key);
    expect(h.controller.loadedInstanceKeys()).toEqual([]);
  });

  it("drops a scan whose result arrived after the project closed", async () => {
    let releaseScan: ((plugins: DiscoveredProjectPlugin[]) => void) | undefined;
    h.trust.set(PROJECT_A, {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ["acme.dashboard"],
      stagedPluginIds: [],
      mutedPluginIds: [],
    });
    h.deps.discover.mockImplementation(
      () =>
        new Promise<ProjectPluginDiscoveryResult>((resolve) => {
          releaseScan = (plugins) => resolve({ root: "/x", plugins });
        })
    );

    const opening = h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await Promise.resolve();
    const closing = h.controller.onProjectClosed(PROJECT_A);
    releaseScan!([discovered("acme.dashboard")]);
    await opening;
    await closing;

    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
  });

  it("serializes two rapid opens of the same project", async () => {
    const order: string[] = [];
    h.trust.set(PROJECT_A, {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ["acme.dashboard"],
      stagedPluginIds: [],
      mutedPluginIds: [],
    });
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    h.deps.discover.mockImplementation(async (root: string) => {
      order.push("scan-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("scan-end");
      return { root, plugins: [discovered("acme.dashboard")] };
    });

    await Promise.all([
      h.controller.onProjectOpened(PROJECT_A, ROOT_A),
      h.controller.onProjectOpened(PROJECT_A, ROOT_A),
    ]);

    expect(order).toEqual(["scan-start", "scan-end", "scan-start", "scan-end"]);
    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);
  });
});

describe("hot-reload hook", () => {
  function enable(projectId: string, ids: string[]): void {
    h.trust.set(projectId, {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ids,
      stagedPluginIds: [],
      mutedPluginIds: [],
    });
  }

  it("reports what is loaded, and nothing for an unknown project", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual(["acme.dashboard"]);
    expect(h.controller.loadedManifestIds(PROJECT_B)).toEqual([]);
  });

  it("unloads and re-loads the named plugin, which the open path alone would skip", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);

    // A plain re-open is idempotent: an already-loaded plugin is left alone.
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);
    expect(h.deps.unloadProjectPlugin).not.toHaveBeenCalled();

    await h.controller.reloadChanged(PROJECT_A, ROOT_A, ["acme.dashboard"]);

    const instanceKey = makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard");
    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(instanceKey);
    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(2);
    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual(["acme.dashboard"]);
  });

  it("leaves plugins it was not asked to reload alone", async () => {
    enable(PROJECT_A, ["acme.dashboard", "acme.deploy"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.deploy")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(2);

    await h.controller.reloadChanged(PROJECT_A, ROOT_A, ["acme.deploy"]);

    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledTimes(1);
    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(
      makeProjectPluginInstanceKey(PROJECT_A, "acme.deploy")
    );
    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(3);
  });

  it("does not re-load into a project whose trust was revoked mid-reload", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    let releaseScan: (() => void) | undefined;
    h.deps.discover.mockImplementation(
      async () =>
        new Promise<ProjectPluginDiscoveryResult>((resolve) => {
          releaseScan = () => resolve({ root: "/x", plugins: [discovered("acme.dashboard")] });
        })
    );

    const reloading = h.controller.reloadChanged(PROJECT_A, ROOT_A, ["acme.dashboard"]);
    await Promise.resolve();
    const revoking = h.controller.setTrust(PROJECT_A, "disabled");
    releaseScan!();
    await reloading;
    await revoking;

    // Only the reload's own unload ran; the revoked project got no second load.
    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);
    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual([]);
  });

  it("does nothing for a project that was already closed", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.onProjectClosed(PROJECT_A);
    h.deps.loadProjectPlugin.mockClear();

    h.controller.dispose();
    await h.controller.reloadChanged(PROJECT_A, ROOT_A, ["acme.dashboard"]);

    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
  });
});

describe("per-plugin mute", () => {
  function enable(projectId: string, ids: string[], muted: string[] = []): void {
    h.trust.set(projectId, {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ids,
      stagedPluginIds: [],
      mutedPluginIds: muted,
    });
  }

  it("skips a muted plugin at the load call, not just in the record", async () => {
    enable(PROJECT_A, ["acme.dashboard", "acme.linter"], ["acme.linter"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.linter")]);

    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual(["acme.dashboard"]);
    const linter = h.controller.listProjectPlugins(PROJECT_A).find((p) => p.id === "acme.linter")!;
    expect(linter.muted).toBe(true);
    expect(linter.state).toBe("blocked");
  });

  it("unloads a running plugin when it is muted, and reloads it when unmuted", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual(["acme.dashboard"]);

    await h.controller.setMuted(PROJECT_A, "acme.dashboard", true);
    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(
      makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard")
    );
    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual([]);

    await h.controller.setMuted(PROJECT_A, "acme.dashboard", false);
    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual(["acme.dashboard"]);
  });

  it("persists the muted id alongside staged, and leaves the trust decision alone", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    await h.controller.setMuted(PROJECT_A, "acme.dashboard", true);

    const record = h.trust.get(PROJECT_A)!;
    expect(record.mutedPluginIds).toEqual(["acme.dashboard"]);
    expect(record.decision).toBe("enabled");
    expect(h.controller.getTrustState(PROJECT_A).enabled).toBe(true);
  });

  it("never purges capability consent — muting is not revoking", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    await h.controller.setMuted(PROJECT_A, "acme.dashboard", true);

    expect(h.deps.purgeConsentForInstance).not.toHaveBeenCalled();
  });

  it("keeps a muted plugin muted across a re-open", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setMuted(PROJECT_A, "acme.dashboard", true);
    h.deps.loadProjectPlugin.mockClear();

    await h.controller.onProjectClosed(PROJECT_A);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual([]);
  });

  it("does not re-stage a muted plugin that disappeared and came back", async () => {
    enable(PROJECT_A, [], ["acme.linter"]);
    h.setDiscovery(ROOT_A, [discovered("acme.linter")]);

    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    // Muted ids are known, so nothing announces them as new arrivals.
    expect(h.events.filter((e) => e.name === "plugin:project-plugin-staged")).toEqual([]);
    expect(h.trust.get(PROJECT_A)!.knownPluginIds).toContain("acme.linter");
    expect(h.trust.get(PROJECT_A)!.stagedPluginIds).toEqual([]);
  });

  it("clears the mute when a staged plugin is explicitly activated", async () => {
    enable(PROJECT_A, [], ["acme.linter"]);
    h.setDiscovery(ROOT_A, [discovered("acme.linter")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    // Unmute first so the plugin reaches `staged`, then activate it.
    await h.controller.setMuted(PROJECT_A, "acme.linter", false);
    await h.controller.setMuted(PROJECT_A, "acme.linter", true);
    await h.controller.setMuted(PROJECT_A, "acme.linter", false);
    await h.controller.activateStaged(PROJECT_A, "acme.linter");

    expect(h.trust.get(PROJECT_A)!.mutedPluginIds).toEqual([]);
  });

  it("is a no-op when the plugin is already in the requested state", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    const writes = h.deps.writeTrust.mock.calls.length;

    await h.controller.setMuted(PROJECT_A, "acme.dashboard", false);

    expect(h.deps.writeTrust.mock.calls.length).toBe(writes);
  });
});
