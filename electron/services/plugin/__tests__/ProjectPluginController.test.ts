import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectPluginController } from "../ProjectPluginController.js";
import type { ProjectPluginControllerDeps } from "../ProjectPluginController.js";
import type {
  DiscoveredProjectPlugin,
  ProjectPluginDiscoveryResult,
} from "../projectPluginDiscovery.js";
import type {
  PluginLoadError,
  PluginManifest,
  ProjectPluginTrustRecord,
} from "../../../../shared/types/plugin.js";
import { makeProjectPluginInstanceKey } from "../../../../shared/types/plugin.js";
import type { ProjectApplicationPreflightFailure } from "../projectApplicationPreflight.js";

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
      fileEditors: [],
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
  loadErrors: Map<string, PluginLoadError>;
  setDiscovery: (projectRoot: string, plugins: DiscoveredProjectPlugin[]) => void;
  events: Array<{ projectId: string; name: string; payload: unknown }>;
}

function makeHarness(): Harness {
  const trust = new Map<string, ProjectPluginTrustRecord>();
  const byRoot = new Map<string, DiscoveredProjectPlugin[]>();
  const loadErrors = new Map<string, PluginLoadError>();
  const events: Harness["events"] = [];

  const deps = {
    discover: vi.fn(async (projectRoot: string): Promise<ProjectPluginDiscoveryResult> => ({
      root: `${projectRoot}/.daintree/plugins`,
      plugins: byRoot.get(projectRoot) ?? [],
    })),
    loadProjectPlugin: vi.fn(async () => true),
    unloadProjectPlugin: vi.fn(),
    settleProjectPluginReload: vi.fn(),
    purgeConsentForInstance: vi.fn(),
    listGlobalPluginIds: vi.fn(() => new Set<string>(["daintree.github"])),
    getPluginLoadError: vi.fn((_instanceKey: string) => loadErrors.get(_instanceKey)),
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
    isEngineIncompatible: vi.fn((_range: string) => false),
    getProjectHomeHolder: vi.fn((_projectId: string): string | null => null),
    preflightApplication: vi.fn(
      async (_args: unknown): Promise<ProjectApplicationPreflightFailure | null> => null
    ),
  };

  return {
    controller: new ProjectPluginController(deps as unknown as ProjectPluginControllerDeps),
    deps: deps as unknown as Harness["deps"],
    trust,
    loadErrors,
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
    expect(h.controller.getTrustState(PROJECT_A).persisted).toBe(false);
  });

  it("a session grant survives a close, a sleep or an idle auto-close (#13843)", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "session");

    for (let reopen = 0; reopen < 2; reopen++) {
      // A second close notification for the same project finds no entry and
      // must leave the retained grant alone.
      await h.controller.onProjectClosed(PROJECT_A);
      await h.controller.onProjectClosed(PROJECT_A);
      expect(h.controller.getTrustState(PROJECT_A)).toEqual({
        projectId: PROJECT_A,
        decision: "session",
        enabled: true,
        persisted: false,
      });

      h.deps.loadProjectPlugin.mockClear();
      h.events.length = 0;
      await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

      expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);
      expect(h.events.some((e) => e.name === "plugin:project-trust-prompt")).toBe(false);
      expect(h.controller.getTrustState(PROJECT_A).decision).toBe("session");
    }
    expect(h.deps.writeTrust).not.toHaveBeenCalled();
  });
});

describe("a session grant across a close (#13843)", () => {
  function loadedNames(): string[] {
    return h.deps.loadProjectPlugin.mock.calls.map(
      (call) => (call[0] as { manifest: PluginManifest }).manifest.name
    );
  }

  async function grantSessionThenClose(plugins: DiscoveredProjectPlugin[]): Promise<void> {
    h.setDiscovery(ROOT_A, plugins);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "session");
    await h.controller.onProjectClosed(PROJECT_A);
    h.deps.loadProjectPlugin.mockClear();
    h.events.length = 0;
  }

  it("stages a plugin that appeared while the project was closed", async () => {
    await grantSessionThenClose([discovered("acme.dashboard")]);

    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.newcomer")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(loadedNames()).toEqual(["acme.dashboard"]);
    const staged = h.events.filter((e) => e.name === "plugin:project-plugin-staged");
    expect(staged.map((e) => (e.payload as { pluginId: string }).pluginId)).toEqual([
      "acme.newcomer",
    ]);
    expect(h.events.some((e) => e.name === "plugin:project-trust-prompt")).toBe(false);

    // The stage is part of the grant now: declined, it stays declined — not
    // re-announced, and not quietly run either, since it is already known.
    await h.controller.onProjectClosed(PROJECT_A);
    h.deps.loadProjectPlugin.mockClear();
    h.events.length = 0;
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(loadedNames()).toEqual(["acme.dashboard"]);
    expect(h.events.some((e) => e.name === "plugin:project-plugin-staged")).toBe(false);
    expect(h.deps.writeTrust).not.toHaveBeenCalled();
  });

  it("keeps the ids a close interrupted mid-activation", async () => {
    const started: string[] = [];
    let gated = false;
    let reachedFirst!: () => void;
    const firstLoadStarted = new Promise<void>((resolve) => {
      reachedFirst = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    h.deps.loadProjectPlugin.mockImplementation(
      async ({ manifest }: { manifest: Readonly<PluginManifest> }) => {
        started.push(manifest.name);
        if (!gated) {
          gated = true;
          reachedFirst();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return true;
      }
    );
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.deploy")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    const granting = h.controller.setTrust(PROJECT_A, "session");
    await firstLoadStarted;
    const closing = h.controller.onProjectClosed(PROJECT_A);
    releaseFirst!();
    await granting;
    await closing;

    expect(started).toEqual(["acme.dashboard"]);
    expect(h.controller.loadedInstanceKeys()).toEqual([]);

    // Both ids were consented to at the click, so both run on reopen — the one
    // the close cut off is not mistaken for new.
    started.length = 0;
    h.events.length = 0;
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(started.sort()).toEqual(["acme.dashboard", "acme.deploy"]);
    expect(h.events.some((e) => e.name === "plugin:project-plugin-staged")).toBe(false);
  });

  it("keeps a muted plugin muted", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.deploy")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "session");
    await h.controller.setMuted(PROJECT_A, "acme.dashboard", true);
    await h.controller.onProjectClosed(PROJECT_A);

    h.deps.loadProjectPlugin.mockClear();
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(loadedNames()).toEqual(["acme.deploy"]);
  });

  it("outranks a remembered no without overwriting it", async () => {
    const disabled: ProjectPluginTrustRecord = {
      decision: "disabled",
      decidedAt: 1,
      knownPluginIds: ["acme.dashboard"],
      stagedPluginIds: [],
      mutedPluginIds: [],
    };
    h.trust.set(PROJECT_A, disabled);
    await grantSessionThenClose([discovered("acme.dashboard")]);

    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(loadedNames()).toEqual(["acme.dashboard"]);
    expect(h.trust.get(PROJECT_A)).toEqual(disabled);
  });

  it("survives the sweep of a project closed behind the controller's back", async () => {
    await grantSessionThenClose([discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    h.setDiscovery(ROOT_B, []);
    h.deps.isProjectClosed.mockImplementation((id: string) => id === PROJECT_A);
    await h.controller.onProjectOpened(PROJECT_B, ROOT_B);
    expect(h.controller.loadedInstanceKeys()).toEqual([]);

    h.deps.isProjectClosed.mockReturnValue(false);
    h.deps.loadProjectPlugin.mockClear();
    h.events.length = 0;
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(loadedNames()).toEqual(["acme.dashboard"]);
    expect(h.events.some((e) => e.name === "plugin:project-trust-prompt")).toBe(false);
  });

  it("is forgotten by a revoke that lands after the close", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "session");

    // The close is queued first, so the revoke's task finds no entry — only
    // the grant the close set aside.
    const closing = h.controller.onProjectClosed(PROJECT_A);
    const revoking = h.controller.setTrust(PROJECT_A, "disabled");
    await closing;
    await revoking;

    expect(h.controller.getTrustState(PROJECT_A).decision).toBe("disabled");
    h.deps.loadProjectPlugin.mockClear();
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
  });

  it("is forgotten by a revoke made after it was restored", async () => {
    await grantSessionThenClose([discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "disabled");
    await h.controller.onProjectClosed(PROJECT_A);

    expect(h.controller.getTrustState(PROJECT_A).decision).toBe("disabled");
    h.deps.loadProjectPlugin.mockClear();
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
  });

  it("is not created by a session click that loses to a close", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    const closing = h.controller.onProjectClosed(PROJECT_A);
    const granting = h.controller.setTrust(PROJECT_A, "session");
    await closing;
    await expect(granting).rejects.toThrow(/closed before the decision was saved/);

    expect(h.controller.getTrustState(PROJECT_A).decision).toBeNull();
  });

  it("ends with the controller", async () => {
    await grantSessionThenClose([discovered("acme.dashboard")]);

    h.controller.dispose();

    expect(h.controller.getTrustState(PROJECT_A)).toEqual({
      projectId: PROJECT_A,
      decision: null,
      enabled: false,
      persisted: false,
    });
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

  it("reports a decision the close race swallowed, rather than resolving as saved", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    // A stale click landing just after a close: the close has queued its
    // teardown but not run it, so the entry is still there when the decision
    // is accepted and gone by the time the decision's own task runs.
    const close = h.controller.onProjectClosed(PROJECT_A);
    const decision = h.controller.setTrust(PROJECT_A, "enabled");

    await expect(decision).rejects.toThrow(/closed before the decision was saved/i);
    await close;
  });

  it("refuses a decision for a project it holds no state for, rather than dropping it", async () => {
    // Silently returning here let the renderer report a decision as saved that
    // was never recorded anywhere.
    await expect(h.controller.setTrust(PROJECT_A, "enabled")).rejects.toThrow(
      /reopen the project/i
    );
    expect(h.deps.writeTrust).not.toHaveBeenCalled();
  });
});

describe("what a failed write means for `persisted` (#12212)", () => {
  it("does not un-persist a stored decision when only bookkeeping failed", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");
    expect(h.controller.getTrustState(PROJECT_A).persisted).toBe(true);

    // A new plugin appears and is staged, then activated — the write here is
    // the known/staged bookkeeping, not the decision, which is already stored.
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.later")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    h.deps.writeTrust.mockReturnValue(false);
    await h.controller.activateStaged(PROJECT_A, "acme.later");

    // The grant itself is still on disk; saying otherwise would re-offer a
    // question the user already answered durably.
    expect(h.controller.getTrustState(PROJECT_A).persisted).toBe(true);
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
      mutedPluginIds: [],
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

  it("keeps a loaded plugin active while attaching its load error", async () => {
    const key = makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard");
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");
    h.loadErrors.set(key, { message: "activate() threw", at: 1 });

    const rows = h.controller.listProjectPlugins(PROJECT_A);
    // The plugin loaded and holds its contributions — the failure is a fact
    // about the last run, not a different kind of row.
    expect(rows[0]!.state).toBe("active");
    expect(rows[0]!.loadError).toEqual({ message: "activate() threw", at: 1 });
  });

  it("leaves loadError off a row with no error and off one that never loaded", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.controller.listProjectPlugins(PROJECT_A)[0]!.loadError).toBeUndefined();
    // A blocked row has no instance loaded, so its key is never even asked for.
    expect(h.deps.getPluginLoadError).not.toHaveBeenCalled();

    await h.controller.setTrust(PROJECT_A, "enabled");
    expect(h.controller.listProjectPlugins(PROJECT_A)[0]!.loadError).toBeUndefined();
  });

  it("carries the manifest's worksWith to the manager, and only when it lists some", async () => {
    const worksWith = ["acme.linear", "daintree.github"];
    h.setDiscovery(ROOT_A, [
      {
        ...discovered("acme.dashboard"),
        manifest: { ...manifestFor("acme.dashboard"), worksWith },
      },
      discovered("acme.plain"),
    ]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    const rows = h.controller.listProjectPlugins(PROJECT_A);
    expect(rows.find((row) => row.id === "acme.dashboard")!.worksWith).toEqual(worksWith);
    expect("worksWith" in rows.find((row) => row.id === "acme.plain")!).toBe(false);
  });
});

describe("notifyLoadErrorChanged", () => {
  const key = makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard");

  async function loadOne(): Promise<void> {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");
  }

  it("pushes a fresh snapshot carrying the error for the loaded instance", async () => {
    await loadOne();
    h.loadErrors.set(key, { message: "boom", at: 2 });
    h.events.length = 0;

    h.controller.notifyLoadErrorChanged(key);

    const changed = h.events.filter((e) => e.name === "plugin:project-plugins-changed");
    expect(changed).toHaveLength(1);
    const payload = changed[0]!.payload as { plugins: Array<{ loadError?: PluginLoadError }> };
    expect(payload.plugins[0]!.loadError).toEqual({ message: "boom", at: 2 });
  });

  it("ignores a key for an instance this project no longer runs", async () => {
    await loadOne();
    await h.controller.setTrust(PROJECT_A, "disabled");
    h.events.length = 0;

    // The generation that produced this error has already been unloaded, so it
    // describes nothing the rows still show.
    h.controller.notifyLoadErrorChanged(key);

    expect(h.events.filter((e) => e.name === "plugin:project-plugins-changed")).toHaveLength(0);
  });

  it("ignores a malformed key and an unknown project", async () => {
    await loadOne();
    h.events.length = 0;

    h.controller.notifyLoadErrorChanged("acme.dashboard");
    h.controller.notifyLoadErrorChanged(makeProjectPluginInstanceKey(PROJECT_B, "acme.dashboard"));

    expect(h.events.filter((e) => e.name === "plugin:project-plugins-changed")).toHaveLength(0);
  });

  it("stays silent after dispose", async () => {
    await loadOne();
    h.controller.dispose();
    h.events.length = 0;

    h.controller.notifyLoadErrorChanged(key);

    expect(h.events.filter((e) => e.name === "plugin:project-plugins-changed")).toHaveLength(0);
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

  it("does not start a later plugin in the batch once a revoke lands mid-flight", async () => {
    const started: string[] = [];
    let reachedFirst!: () => void;
    const firstLoadStarted = new Promise<void>((resolve) => {
      reachedFirst = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    h.deps.loadProjectPlugin.mockImplementation(
      async ({ manifest }: { manifest: Readonly<PluginManifest> }) => {
        started.push(manifest.name);
        if (started.length === 1) {
          reachedFirst();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return true;
      }
    );
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.deploy")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    const trusting = h.controller.setTrust(PROJECT_A, "enabled");
    await firstLoadStarted;
    // Revoke lands while the first plugin of the batch is still activating.
    const revoking = h.controller.setTrust(PROJECT_A, "disabled");
    releaseFirst!();
    await trusting;
    await revoking;

    // The second plugin must never have been handed to the loader at all —
    // running its `activate` and unloading it afterwards is not the same thing.
    expect(started).toEqual(["acme.dashboard"]);
    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(
      makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard")
    );
    expect(h.controller.loadedInstanceKeys()).toEqual([]);
  });

  it("never starts plugins when a revoke is queued before the enable task runs", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.deploy")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    // Both requested in the same tick, so the enable's task has not started when
    // the revoke bumps the generation. Reading the generation at task start would
    // read the revoke's own bump and let the enable run anyway.
    const trusting = h.controller.setTrust(PROJECT_A, "enabled");
    const revoking = h.controller.setTrust(PROJECT_A, "disabled");
    await trusting;
    await revoking;

    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
    expect(h.controller.getTrustState(PROJECT_A)).toEqual({
      projectId: PROJECT_A,
      decision: "disabled",
      enabled: false,
      persisted: true,
    });
  });

  it("does not activate a staged plugin when a revoke is queued behind the click", async () => {
    h.trust.set(PROJECT_A, {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ["acme.dashboard"],
      stagedPluginIds: ["acme.dashboard"],
      mutedPluginIds: [],
    });
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();

    const activating = h.controller.activateStaged(PROJECT_A, "acme.dashboard");
    const revoking = h.controller.setTrust(PROJECT_A, "disabled");
    await activating;
    await revoking;

    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
  });

  it("still opens a project whose reopen was requested before the close ran", async () => {
    h.trust.set(PROJECT_A, {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ["acme.dashboard"],
      stagedPluginIds: [],
      mutedPluginIds: [],
    });
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    h.deps.loadProjectPlugin.mockClear();

    // The reopen is requested while the close is still queued, so it captures
    // the entry the close is about to delete. That must not swallow the open.
    const closing = h.controller.onProjectClosed(PROJECT_A);
    const reopening = h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await closing;
    await reopening;

    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);
    expect(h.controller.loadedInstanceKeys()).toEqual([
      makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard"),
    ]);
  });

  it("does not open a project whose revoke lands during the cross-project sweep", async () => {
    h.trust.set(PROJECT_A, {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ["acme.dashboard", "acme.deploy"],
      stagedPluginIds: [],
      mutedPluginIds: [],
    });
    h.setDiscovery(ROOT_B, []);
    await h.controller.onProjectOpened(PROJECT_B, ROOT_B);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    h.deps.loadProjectPlugin.mockClear();

    // A second known plugin appears, so this reopen has real work to do. But it
    // sweeps B first, and that sweep awaits — revoke A from inside the
    // synchronous `isProjectClosed` probe, immediately before that await, so the
    // bump lands in the one window the entry guard cannot see.
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard"), discovered("acme.deploy")]);
    h.deps.isProjectClosed.mockImplementation((id: string) => {
      if (id !== PROJECT_B) return false;
      void h.controller.setTrust(PROJECT_A, "disabled");
      return true;
    });

    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
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

  it("does not start a plugin when a revoke is requested right behind a warm open (#12230)", async () => {
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "enabled");
    // The folder goes away and comes back, so the warm open below has a known
    // plugin to load rather than one that is already running.
    h.setDiscovery(ROOT_A, []);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    h.deps.loadProjectPlugin.mockClear();

    const opening = h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    const revoking = h.controller.setTrust(PROJECT_A, "disabled");
    await opening;
    await revoking;

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

describe("a revoke that races a queued decision, a close, or a failing write (#12230)", () => {
  function enabledRecord(): ProjectPluginTrustRecord {
    return {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ["acme.dashboard"],
      stagedPluginIds: [],
      mutedPluginIds: [],
    };
  }

  it("still unloads and purges when an enable is queued behind the revoke", async () => {
    h.trust.set(PROJECT_A, enabledRecord());
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    // A revoke is never treated as superseded: it owes an unload and a consent
    // purge on its way past, even when the user immediately re-enables.
    const revoking = h.controller.setTrust(PROJECT_A, "disabled");
    const enabling = h.controller.setTrust(PROJECT_A, "enabled");
    await revoking;
    await enabling;

    expect(h.deps.purgeConsentForInstance).toHaveBeenCalledWith(
      makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard")
    );
    expect(h.controller.getTrustState(PROJECT_A).decision).toBe("enabled");
  });

  it("writes the revoke when a close is queued behind it", async () => {
    h.trust.set(PROJECT_A, enabledRecord());
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    const revoking = h.controller.setTrust(PROJECT_A, "disabled");
    const closing = h.controller.onProjectClosed(PROJECT_A);
    await revoking;
    await closing;

    expect(h.trust.get(PROJECT_A)?.decision).toBe("disabled");
  });

  it("writes the revoke even when the close deleted the entry first", async () => {
    h.trust.set(PROJECT_A, enabledRecord());
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    // The close is queued first and deletes the entry, so the revoke's task
    // finds nothing live. It still owes the record and the consent purge.
    const closing = h.controller.onProjectClosed(PROJECT_A);
    const revoking = h.controller.setTrust(PROJECT_A, "disabled");
    await closing;
    await revoking;

    expect(h.trust.get(PROJECT_A)?.decision).toBe("disabled");
    expect(h.deps.purgeConsentForInstance).toHaveBeenCalledWith(
      makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard")
    );
  });

  it("does not flush bookkeeping when the batch's last load is invalidated", async () => {
    h.trust.set(PROJECT_A, {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ["acme.known"],
      stagedPluginIds: [],
      mutedPluginIds: [],
    });
    // The new plugin stages first (marking bookkeeping dirty), the known one
    // loads last — so nothing is left to re-check the generation after it.
    h.setDiscovery(ROOT_A, [discovered("acme.new"), discovered("acme.known")]);
    let releaseLoad: (() => void) | undefined;
    let reachedLoad!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      reachedLoad = resolve;
    });
    h.deps.loadProjectPlugin.mockImplementation(async () => {
      reachedLoad();
      await new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      return true;
    });

    const opening = h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await loadStarted;
    const revoking = h.controller.setTrust(PROJECT_A, "disabled");
    releaseLoad!();
    await opening;
    await revoking;

    // The only write is the revoke's. Flushing the still-"enabled" record first
    // would leave the store enabled if that second write were the one to fail.
    expect(
      h.deps.writeTrust.mock.calls.map((c) => (c[1] as ProjectPluginTrustRecord).decision)
    ).toEqual(["disabled"]);
  });

  it("still revokes and still announces the change when the write throws", async () => {
    h.trust.set(PROJECT_A, enabledRecord());
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    // A throwing store is not a returned `false`: without the try/catch around
    // the write, this rejects the queued task, `serialize` swallows it, and
    // `emitChanged` never runs — so the revoke lands but the renderer is never
    // told, and keeps showing trust the host no longer grants.
    h.deps.writeTrust.mockImplementation(() => {
      throw new Error("EROFS: read-only file system");
    });
    h.events.length = 0;
    await expect(h.controller.setTrust(PROJECT_A, "disabled")).rejects.toThrow(/settings file/i);

    expect(h.controller.loadedInstanceKeys()).toEqual([]);
    const changed = h.events.filter((e) => e.name === "plugin:project-plugins-changed").at(-1);
    expect((changed!.payload as { trust: unknown }).trust).toEqual({
      projectId: PROJECT_A,
      decision: "disabled",
      enabled: false,
      persisted: false,
    });
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
    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(instanceKey, { reload: true });
    expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(2);
    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual(["acme.dashboard"]);
    // Settled once, after the reload's own load ran, as kept.
    expect(h.deps.settleProjectPluginReload).toHaveBeenCalledExactlyOnceWith(instanceKey, true);
    expect(h.deps.settleProjectPluginReload.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.deps.loadProjectPlugin.mock.invocationCallOrder[1]!
    );
  });

  it("settles a reload whose plugin never comes back, and one whose open pass throws", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    const instanceKey = makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard");

    h.setDiscovery(ROOT_A, []);
    await h.controller.reloadChanged(PROJECT_A, ROOT_A, ["acme.dashboard"]);
    expect(h.deps.settleProjectPluginReload).toHaveBeenCalledExactlyOnceWith(instanceKey, false);
    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual([]);

    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    h.deps.discover.mockRejectedValueOnce(new Error("scan failed"));
    await h.controller.reloadChanged(PROJECT_A, ROOT_A, ["acme.dashboard"]);
    expect(h.deps.settleProjectPluginReload).toHaveBeenCalledTimes(2);
    expect(h.deps.settleProjectPluginReload).toHaveBeenLastCalledWith(instanceKey, false);
  });

  it("settles as not kept when a close overtakes the reload, even though the load ran", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    const instanceKey = makeProjectPluginInstanceKey(PROJECT_A, "acme.dashboard");

    let releaseLoad!: () => void;
    h.deps.loadProjectPlugin.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseLoad = () => resolve(true);
        })
    );
    const reloading = h.controller.reloadChanged(PROJECT_A, ROOT_A, ["acme.dashboard"]);
    await vi.waitFor(() => expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(2));
    const closing = h.controller.onProjectClosed(PROJECT_A);
    releaseLoad();
    await reloading;
    await closing;

    expect(h.deps.settleProjectPluginReload).toHaveBeenCalledExactlyOnceWith(instanceKey, false);
  });

  it("settles nothing for an id that was not loaded", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    await h.controller.reloadChanged(PROJECT_A, ROOT_A, ["acme.missing"]);

    expect(h.deps.settleProjectPluginReload).not.toHaveBeenCalled();
  });

  it("whenSettled waits for queued work, including work queued while waiting", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    const scans: Array<() => void> = [];
    h.deps.discover.mockImplementation(
      async () =>
        new Promise<ProjectPluginDiscoveryResult>((resolve) => {
          scans.push(() => resolve({ root: "/x", plugins: [discovered("acme.dashboard")] }));
        })
    );

    await h.controller.whenSettled(PROJECT_B);
    expect(h.controller.hasQueuedWork(PROJECT_A)).toBe(false);
    const opening = h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.controller.hasQueuedWork(PROJECT_A)).toBe(true);
    let settled = false;
    const waiting = h.controller.whenSettled(PROJECT_A).then(() => {
      settled = true;
    });
    // Queued after the waiter started: it still has to be waited for.
    const reopening = h.controller.onProjectOpened(PROJECT_A, ROOT_A);

    await vi.waitFor(() => expect(scans).toHaveLength(1));
    scans[0]!();
    await opening;
    await vi.waitFor(() => expect(scans).toHaveLength(2));
    expect(settled).toBe(false);
    scans[1]!();
    await waiting;
    await reopening;
    expect(settled).toBe(true);
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
      makeProjectPluginInstanceKey(PROJECT_A, "acme.deploy"),
      { reload: true }
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

  it("is a no-op when the plugin is already in the requested state", async () => {
    enable(PROJECT_A, ["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    const writes = h.deps.writeTrust.mock.calls.length;

    await h.controller.setMuted(PROJECT_A, "acme.dashboard", false);

    expect(h.deps.writeTrust.mock.calls.length).toBe(writes);
  });
});

describe("project application (#14097)", () => {
  const APP = { name: "Ledger", destination: "home" as const };

  function withApplication(name: string): DiscoveredProjectPlugin {
    const d = discovered(name);
    return {
      ...d,
      manifest: {
        ...d.manifest!,
        engines: { daintree: ">=0.1.0" },
        application: APP,
        contributes: {
          ...d.manifest!.contributes,
          panels: [{ id: "home", name: "Home", iconId: "puzzle", color: "#ffffff" }],
          views: [{ id: "home", componentPath: "dist/home.js", location: "panel" }],
          surfaces: { projectHome: { viewId: "home" } },
        },
      } as unknown as Readonly<PluginManifest>,
    };
  }

  function enable(ids: string[], muted: string[] = []): void {
    h.trust.set(PROJECT_A, {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ids,
      stagedPluginIds: [],
      mutedPluginIds: muted,
    });
  }

  function lastApplication(): unknown {
    const changed = h.events.filter((e) => e.name === "plugin:project-plugins-changed").at(-1);
    return (changed!.payload as { application: unknown }).application;
  }

  it("publishes null when no plugin declares an application", async () => {
    enable(["acme.dashboard"]);
    h.setDiscovery(ROOT_A, [discovered("acme.dashboard")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(lastApplication()).toBeNull();
  });

  it("publishes the loaded owner's application as active", async () => {
    enable(["acme.ledger"]);
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(lastApplication()).toEqual({
      status: "active",
      ownerId: "acme.ledger",
      version: "1.0.0",
      instanceId: makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger"),
      application: APP,
      fallback: null,
    });
  });

  it("falls back while the project's plugins are untrusted", async () => {
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.controller.getProjectApplication(PROJECT_A)).toMatchObject({
      status: "disabled",
      reason: "untrusted",
      fallback: "standard-workspace",
    });
  });

  it("falls back when the owner is muted, and returns when it is switched back on", async () => {
    enable(["acme.ledger"], ["acme.ledger"]);
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(lastApplication()).toMatchObject({ status: "disabled", reason: "muted" });

    await h.controller.setMuted(PROJECT_A, "acme.ledger", false);
    expect(lastApplication()).toMatchObject({ status: "active" });
  });

  it("is unavailable when the owner's load is refused", async () => {
    enable(["acme.ledger"]);
    h.deps.loadProjectPlugin.mockResolvedValue(false);
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(lastApplication()).toMatchObject({
      status: "unavailable",
      reason: "load-failed",
      fallback: "standard-workspace",
    });
  });

  it("does not load an owner outside its engine range, and reports it unavailable", async () => {
    enable(["acme.ledger", "acme.dashboard"]);
    h.deps.isEngineIncompatible.mockReturnValue(true);
    const dashboard = discovered("acme.dashboard");
    h.setDiscovery(ROOT_A, [
      withApplication("acme.ledger"),
      { ...dashboard, manifest: { ...dashboard.manifest!, engines: { daintree: ">=99.0.0" } } },
    ]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.deps.isEngineIncompatible).toHaveBeenCalledWith(">=0.1.0");
    // The range stays advisory for a plugin that declares no application.
    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual(["acme.dashboard"]);
    expect(lastApplication()).toMatchObject({
      status: "unavailable",
      reason: "engine-incompatible",
    });
  });

  it("tells the project's views the application is loading while its owner loads", async () => {
    enable(["acme.ledger"]);
    let finish: (ok: boolean) => void = () => {};
    h.deps.loadProjectPlugin.mockImplementation(
      () => new Promise<boolean>((resolve) => (finish = resolve))
    );
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    const opening = h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await vi.waitFor(() => expect(h.deps.loadProjectPlugin).toHaveBeenCalled());
    expect(lastApplication()).toMatchObject({ status: "loading", fallback: "standard-workspace" });

    finish(true);
    await opening;
    expect(lastApplication()).toMatchObject({ status: "active" });
  });

  it("does not load an incompatible owner when it is turned on from staging", async () => {
    h.trust.set(PROJECT_A, {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ["acme.ledger"],
      stagedPluginIds: ["acme.ledger"],
      mutedPluginIds: [],
    });
    h.deps.isEngineIncompatible.mockReturnValue(true);
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.activateStaged(PROJECT_A, "acme.ledger");
    expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
    expect(lastApplication()).toMatchObject({
      status: "unavailable",
      reason: "engine-incompatible",
    });
  });

  it("takes down a loaded owner once its range no longer admits this Daintree", async () => {
    enable(["acme.ledger"]);
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual(["acme.ledger"]);

    h.deps.isEngineIncompatible.mockReturnValue(true);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(
      makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger")
    );
    expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual([]);
  });

  it("reports a retried load as loading, not as the failure it is retrying", async () => {
    enable(["acme.ledger"]);
    h.deps.loadProjectPlugin.mockResolvedValueOnce(false);
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(lastApplication()).toMatchObject({ reason: "load-failed" });

    let finish: (ok: boolean) => void = () => {};
    h.deps.loadProjectPlugin.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finish = resolve))
    );
    const retry = h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await vi.waitFor(() => expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(2));
    expect(lastApplication()).toMatchObject({ status: "loading" });
    finish(true);
    await retry;
    expect(lastApplication()).toMatchObject({ status: "active" });
  });

  it("is disabled while the owner waits to be turned on, and active once it is", async () => {
    h.trust.set(PROJECT_A, {
      decision: "enabled",
      decidedAt: 0,
      knownPluginIds: ["acme.ledger"],
      stagedPluginIds: ["acme.ledger"],
      mutedPluginIds: [],
    });
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(lastApplication()).toMatchObject({ status: "disabled", reason: "staged" });

    await h.controller.activateStaged(PROJECT_A, "acme.ledger");
    expect(lastApplication()).toMatchObject({ status: "active" });
  });

  it("treats a load that throws as failed, and clears the failure when a reload succeeds", async () => {
    enable(["acme.ledger"]);
    h.deps.loadProjectPlugin.mockRejectedValueOnce(new Error("worker failed to fork"));
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(lastApplication()).toMatchObject({ status: "unavailable", reason: "load-failed" });

    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(lastApplication()).toMatchObject({ status: "active" });
  });

  it("falls back once trust is revoked", async () => {
    enable(["acme.ledger"]);
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    await h.controller.setTrust(PROJECT_A, "disabled");
    const application = lastApplication() as Record<string, unknown>;
    expect(application).toMatchObject({ status: "disabled", reason: "untrusted" });
    expect(application.instanceId).toBeUndefined();
  });

  it("is replaced when another plugin holds the Home it lands on", async () => {
    enable(["acme.ledger"]);
    h.deps.getProjectHomeHolder.mockReturnValue("project:other");
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(lastApplication()).toMatchObject({ status: "replaced", heldBy: "project:other" });
  });

  it("applies neither application when two plugins declare one", async () => {
    enable(["acme.ledger", "acme.books"]);
    h.setDiscovery(ROOT_A, [withApplication("acme.ledger"), withApplication("acme.books")]);
    await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
    expect(lastApplication()).toMatchObject({
      status: "unavailable",
      reason: "owner-ambiguous",
      candidates: ["acme.books", "acme.ledger"],
    });
  });

  it("knows nothing about a project it has not opened", () => {
    expect(h.controller.getProjectApplication(PROJECT_B)).toBeNull();
  });

  describe("payload preflight (#14113)", () => {
    const MISSING = {
      reason: "assets-missing" as const,
      problems: ['views[0].componentPath "dist/home.js" is missing from the plugin'],
    };
    const instanceKey = makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger");

    it("checks an owner's payload before loading it, and only an owner's", async () => {
      enable(["acme.ledger", "acme.dashboard"]);
      h.setDiscovery(ROOT_A, [withApplication("acme.ledger"), discovered("acme.dashboard")]);
      await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

      expect(h.deps.preflightApplication).toHaveBeenCalledExactlyOnceWith({
        projectId: PROJECT_A,
        projectRoot: ROOT_A,
        dir: "/tmp/plugins/ledger",
        manifest: expect.objectContaining({ name: "acme.ledger" }),
      });
      expect(h.deps.preflightApplication.mock.invocationCallOrder[0]).toBeLessThan(
        h.deps.loadProjectPlugin.mock.invocationCallOrder[0]!
      );
    });

    it("does not load a payload that fails, and says what it found", async () => {
      enable(["acme.ledger"]);
      h.deps.preflightApplication.mockResolvedValue(MISSING);
      h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
      await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

      expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
      expect(lastApplication()).toEqual({
        status: "unavailable",
        ownerId: "acme.ledger",
        version: "1.0.0",
        application: APP,
        reason: "assets-missing",
        problems: MISSING.problems,
        fallback: "standard-workspace",
      });
      const row = h.controller.listProjectPlugins(PROJECT_A)[0]!;
      expect(row.state).toBe("blocked");
      expect(row.loadError?.message).toBe(MISSING.problems[0]);
    });

    it("reports a database written by a newer copy as schema-too-new", async () => {
      enable(["acme.ledger"]);
      const problems = ['database "ledger" is at schema version 4, but version 1.0.0 declares 3'];
      h.deps.preflightApplication.mockResolvedValue({ reason: "schema-too-new", problems });
      h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
      await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

      expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
      expect(lastApplication()).toMatchObject({
        status: "unavailable",
        reason: "schema-too-new",
        problems,
      });
    });

    it("retries on the next reconcile, and clears the finding once the payload passes", async () => {
      enable(["acme.ledger"]);
      h.deps.preflightApplication.mockResolvedValueOnce(MISSING);
      h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
      await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
      expect(lastApplication()).toMatchObject({ reason: "assets-missing" });

      // The watcher's rescan after the missing file lands: nothing was loaded,
      // so it names no ids and the open pass is what retries.
      await h.controller.reloadChanged(PROJECT_A, ROOT_A, []);

      expect(h.deps.preflightApplication).toHaveBeenCalledTimes(2);
      expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual(["acme.ledger"]);
      const application = lastApplication() as Record<string, unknown>;
      expect(application).toMatchObject({ status: "active" });
      expect(application.problems).toBeUndefined();
      expect(h.controller.listProjectPlugins(PROJECT_A)[0]!.loadError).toBeUndefined();
    });

    it("takes a running owner down when its update fails, and settles its reload as not kept", async () => {
      enable(["acme.ledger"]);
      h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
      await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
      expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual(["acme.ledger"]);

      h.deps.preflightApplication.mockResolvedValueOnce(MISSING);
      await h.controller.reloadChanged(PROJECT_A, ROOT_A, ["acme.ledger"]);

      expect(h.deps.unloadProjectPlugin).toHaveBeenCalledWith(instanceKey, { reload: true });
      expect(h.deps.loadProjectPlugin).toHaveBeenCalledTimes(1);
      expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual([]);
      expect(h.deps.settleProjectPluginReload).toHaveBeenCalledExactlyOnceWith(instanceKey, false);
      expect(lastApplication()).toMatchObject({ status: "unavailable", reason: "assets-missing" });
    });

    it("loads nothing when a close overtakes the check, whatever the check found", async () => {
      for (const found of [null, MISSING]) {
        h = makeHarness();
        enable(["acme.ledger"]);
        let finish!: (result: typeof found) => void;
        h.deps.preflightApplication.mockImplementationOnce(
          () => new Promise((resolve) => (finish = resolve))
        );
        h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
        const opening = h.controller.onProjectOpened(PROJECT_A, ROOT_A);
        await vi.waitFor(() => expect(h.deps.preflightApplication).toHaveBeenCalled());
        const closing = h.controller.onProjectClosed(PROJECT_A);
        finish(found);
        await opening;
        await closing;

        expect(h.deps.loadProjectPlugin).not.toHaveBeenCalled();
        expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual([]);
      }
    });

    it("forgets the finding with the project, so a reopen checks the files again", async () => {
      enable(["acme.ledger"]);
      h.deps.preflightApplication.mockResolvedValueOnce(MISSING);
      h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
      await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
      await h.controller.onProjectClosed(PROJECT_A);

      await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

      expect(h.deps.preflightApplication).toHaveBeenCalledTimes(2);
      expect(lastApplication()).toMatchObject({ status: "active" });
    });

    it("loads as before when the check itself throws", async () => {
      enable(["acme.ledger"]);
      h.deps.preflightApplication.mockRejectedValueOnce(new Error("disk went away"));
      h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
      await h.controller.onProjectOpened(PROJECT_A, ROOT_A);

      expect(h.controller.loadedManifestIds(PROJECT_A)).toEqual(["acme.ledger"]);
      expect(lastApplication()).toMatchObject({ status: "active" });
    });

    it("leaves a muted owner's row clean, and checks again when it is switched back on", async () => {
      enable(["acme.ledger"]);
      h.deps.preflightApplication.mockResolvedValueOnce(MISSING);
      h.setDiscovery(ROOT_A, [withApplication("acme.ledger")]);
      await h.controller.onProjectOpened(PROJECT_A, ROOT_A);
      await h.controller.setMuted(PROJECT_A, "acme.ledger", true);

      expect(h.controller.listProjectPlugins(PROJECT_A)[0]!.loadError).toBeUndefined();
      expect(lastApplication()).toMatchObject({ status: "disabled", reason: "muted" });

      await h.controller.setMuted(PROJECT_A, "acme.ledger", false);
      expect(h.deps.preflightApplication).toHaveBeenCalledTimes(2);
      expect(lastApplication()).toMatchObject({ status: "active" });
    });
  });
});
