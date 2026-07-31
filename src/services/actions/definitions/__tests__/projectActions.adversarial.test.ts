import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { Project } from "@shared/types";

const projectClientMock = vi.hoisted(() => ({
  openDialog: vi.fn(),
  getAll: vi.fn(),
  getCurrent: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  detectRunners: vi.fn(),
  getStats: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const projectSettingsStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const projectMruMock = vi.hoisted(() => ({
  getMruProjects: vi.fn<(projects: readonly Project[]) => Project[]>(() => []),
}));

vi.mock("@/clients", () => ({ projectClient: projectClientMock }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: projectStoreMock }));
vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: projectSettingsStoreMock,
}));
vi.mock("@shared/utils/projectMru", () => projectMruMock);
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { registerProjectActions } from "../projectActions";

function setupActions(): {
  run: (id: string, args?: unknown, ctx?: Record<string, unknown>) => Promise<unknown>;
} {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {
    onOpenProjectSwitcherPalette: vi.fn(),
    onConfirmCloseActiveProject: vi.fn(),
  } as unknown as ActionCallbacks;
  registerProjectActions(actions, callbacks);
  return {
    run: async (id, args, ctx) => {
      const factory = actions.get(id);
      if (!factory) throw new Error(`missing ${id}`);
      const def = factory() as AnyActionDefinition;
      return def.run(args, (ctx ?? {}) as never);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(projectClientMock)) fn.mockResolvedValue(undefined);
  projectStoreMock.getState.mockReturnValue({ currentProject: null, projects: [] });
  projectSettingsStoreMock.getState.mockReturnValue({
    projectId: null,
    setSettings: vi.fn(),
  });
  projectMruMock.getMruProjects.mockReturnValue([]);
});

describe("projectActions adversarial", () => {
  describe("history navigation", () => {
    // Destination selection belongs to the main-process history service; this
    // action only has to reach it and stay dispatchable from the command
    // palette.
    function mockHistory() {
      const peek = vi.fn().mockResolvedValue(null);
      // Node environment: no jsdom window, so the bridge is stubbed on globalThis.
      (globalThis as unknown as { window: unknown }).window = {
        electron: { projectHistory: { peek } },
      };
      return peek;
    }

    it("project.mruCycleOlder asks main for the last project", async () => {
      const peek = mockHistory();
      const { run } = setupActions();

      await run("project.mruCycleOlder");

      expect(peek).toHaveBeenCalledTimes(1);
    });

    it("does not throw when there is nowhere to go", async () => {
      mockHistory();
      const { run } = setupActions();

      await expect(run("project.mruCycleOlder")).resolves.not.toThrow();
    });
  });

  describe("project.getSettings", () => {
    it("falls back to ctx.projectId when projectId is omitted", async () => {
      const { run } = setupActions();
      await run("project.getSettings", undefined, { projectId: "proj-active" });
      expect(projectClientMock.getSettings).toHaveBeenCalledWith("proj-active");
    });

    it("prefers explicit projectId over ctx", async () => {
      const { run } = setupActions();
      await run("project.getSettings", { projectId: "proj-explicit" }, { projectId: "proj-ctx" });
      expect(projectClientMock.getSettings).toHaveBeenCalledWith("proj-explicit");
    });

    it("throws when projectId is omitted and no active project in ctx", async () => {
      const { run } = setupActions();
      await expect(run("project.getSettings", undefined)).rejects.toThrow("No active project");
    });

    // #11524: this action sits on every MCP tier's allowlist, and
    // ProjectSettingsManager resolves secure storage into `environmentVariables`
    // in plaintext before returning. Returning the client payload verbatim
    // handed agents the user's API keys.
    it("strips secrets and bulk data from the settings it returns", async () => {
      projectClientMock.getSettings.mockResolvedValue({
        runCommands: [{ id: "r1", name: "dev", command: "npm run dev" }],
        worktreePathPattern: "../{project}-{branch}",
        notificationOverrides: { completedEnabled: false },
        terminalSettings: { shell: "/bin/zsh", scrollbackLines: 5000 },
        environmentVariables: { OPENAI_API_KEY: "sk-live-secret", PUBLIC_URL: "https://x.test" },
        secureEnvironmentVariables: ["OPENAI_API_KEY"],
        insecureEnvironmentVariables: ["LEGACY_TOKEN"],
        unresolvedSecureEnvironmentVariables: ["ROTATED_KEY"],
        projectIconSvg: "<svg>...250KB...</svg>",
      });
      const { run } = setupActions();

      const result = await run("project.getSettings", { projectId: "proj-1" });

      // Exact equality rather than key-by-key absence checks: this also proves
      // nothing unexpected rode along, and that the operational fields survive
      // untouched.
      expect(result).toEqual({
        runCommands: [{ id: "r1", name: "dev", command: "npm run dev" }],
        worktreePathPattern: "../{project}-{branch}",
        notificationOverrides: { completedEnabled: false },
        terminalSettings: { shell: "/bin/zsh", scrollbackLines: 5000 },
      });
      // The secret must be absent from the payload entirely, not merely
      // relocated under another key — serialize and search.
      expect(JSON.stringify(result)).not.toContain("sk-live-secret");
    });

    it("drops internal and unclassified fields rather than forwarding them", async () => {
      projectClientMock.getSettings.mockResolvedValue({
        runCommands: [],
        daintreeMcpTier: "system",
        resourceEnvironments: { prod: { connect: "ssh -i ~/.ssh/id_ed25519 deploy@prod" } },
        commandOverrides: [{ id: "c1" }],
        preferredEditor: { command: "code" },
        fleetSavedScopes: [{ kind: "snapshot", id: "s1" }],
        gitInitDefaults: { createInitialCommit: true },
        githubRemote: "origin",
        devServerDismissed: true,
        browserAllowedHosts: ["internal.corp.test"],
        // A field nobody has classified yet: the projection is driven by the
        // exposure table, so anything new defaults to hidden.
        someFutureSetting: "should-not-leak",
      });
      const { run } = setupActions();

      const result = await run("project.getSettings", { projectId: "proj-1" });

      // Everything above except `runCommands` is classified internal, and the
      // unclassified key has no entry at all — the projection keeps none of it.
      expect(result).toEqual({ runCommands: [] });
      expect(JSON.stringify(result)).not.toContain("id_ed25519");
      expect(JSON.stringify(result)).not.toContain("internal.corp.test");
    });

    // The codec keeps each run command whole after validating only `id` and
    // `command`, so an entry carrying extra persisted keys would otherwise ride
    // along inside an exposed field.
    it("projects run command entries down to their known fields", async () => {
      projectClientMock.getSettings.mockResolvedValue({
        runCommands: [
          {
            id: "r1",
            name: "deploy",
            command: "npm run deploy",
            preferredLocation: "dock",
            deployToken: "sk-live-secret",
          },
        ],
      });
      const { run } = setupActions();

      const result = await run("project.getSettings", { projectId: "proj-1" });

      expect(result).toEqual({
        runCommands: [
          { id: "r1", name: "deploy", command: "npm run deploy", preferredLocation: "dock" },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("sk-live-secret");
    });

    it("returns a fresh object so the client's cached settings stay intact", async () => {
      const cached = {
        runCommands: [],
        environmentVariables: { API_KEY: "sk-live-secret" },
        projectIconSvg: "<svg />",
      };
      projectClientMock.getSettings.mockResolvedValue(cached);
      const { run } = setupActions();

      const result = await run("project.getSettings", { projectId: "proj-1" });

      expect(result).not.toBe(cached);
      // projectClient caches and hands the same object to the settings UI, which
      // needs the full payload — filtering in place would corrupt it.
      expect(cached.environmentVariables).toEqual({ API_KEY: "sk-live-secret" });
      expect(cached.projectIconSvg).toBe("<svg />");
    });

    // runCommands is required by both ProjectSettings and the advertised output
    // schema, so a missing payload must still satisfy it rather than yielding a
    // result a validating MCP client would reject.
    it("still satisfies the required runCommands field with no persisted settings", async () => {
      projectClientMock.getSettings.mockResolvedValue(undefined);
      const { run } = setupActions();

      await expect(run("project.getSettings", { projectId: "proj-1" })).resolves.toEqual({
        runCommands: [],
      });
    });
  });

  describe("project.detectRunners", () => {
    it("falls back to ctx.projectId when projectId is omitted", async () => {
      const { run } = setupActions();
      await run("project.detectRunners", undefined, { projectId: "proj-active" });
      expect(projectClientMock.detectRunners).toHaveBeenCalledWith("proj-active");
    });

    it("throws when no projectId and no ctx", async () => {
      const { run } = setupActions();
      await expect(run("project.detectRunners", undefined)).rejects.toThrow("No active project");
    });
  });

  describe("project.getStats", () => {
    it("falls back to ctx.projectId when projectId is omitted", async () => {
      const { run } = setupActions();
      await run("project.getStats", undefined, { projectId: "proj-active" });
      expect(projectClientMock.getStats).toHaveBeenCalledWith("proj-active");
    });

    it("preserves explicit projectId over ctx", async () => {
      const { run } = setupActions();
      await run("project.getStats", { projectId: "explicit" }, { projectId: "ctx" });
      expect(projectClientMock.getStats).toHaveBeenCalledWith("explicit");
    });

    it("throws and skips client call when no projectId and no ctx", async () => {
      const { run } = setupActions();
      await expect(run("project.getStats", undefined)).rejects.toThrow("No active project");
      expect(projectClientMock.getStats).not.toHaveBeenCalled();
    });
  });

  describe("project.saveSettings", () => {
    it("writes through to the active project settings store after saving", async () => {
      const setSettings = vi.fn();
      projectClientMock.getSettings.mockResolvedValueOnce({
        runCommands: [],
        devServerCommand: "",
      });
      projectStoreMock.getState.mockReturnValue({
        currentProject: { id: "proj-active" },
        projects: [],
      });
      projectSettingsStoreMock.getState.mockReturnValue({
        projectId: "proj-active",
        setSettings,
      });

      const { run } = setupActions();
      await run("project.saveSettings", {
        projectId: "proj-active",
        settings: {
          devServerCommand: "npm run dev",
          daintreeMcpTier: "all",
        },
      });

      expect(projectClientMock.saveSettings).toHaveBeenCalledWith("proj-active", {
        runCommands: [],
        devServerCommand: "npm run dev",
      });
      expect(setSettings).toHaveBeenCalledWith({
        runCommands: [],
        devServerCommand: "npm run dev",
      });
    });

    it("does not mutate the store when saving an inactive project", async () => {
      const setSettings = vi.fn();
      projectClientMock.getSettings.mockResolvedValueOnce({ runCommands: [] });
      projectStoreMock.getState.mockReturnValue({
        currentProject: { id: "proj-active" },
        projects: [],
      });
      projectSettingsStoreMock.getState.mockReturnValue({
        projectId: "proj-active",
        setSettings,
      });

      const { run } = setupActions();
      await run("project.saveSettings", {
        projectId: "proj-other",
        settings: { devServerCommand: "npm run dev" },
      });

      expect(setSettings).not.toHaveBeenCalled();
    });
  });
});
