import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { AgentSettings } from "../../../../shared/types/agentSettings.js";
import type { TerminalRecipe } from "../../../../shared/types/project.js";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
import { VIEWLESS_ACTIONS } from "../viewlessActionCatalog.js";
import {
  makeDeps,
  makeHosts,
  makePty,
  makeWorktree,
  PROJECT,
  request,
} from "./viewlessTestDeps.js";

const FEATURE = makeWorktree({
  id: "/repo-wt/feature",
  worktreeId: "/repo-wt/feature",
  path: "/repo-wt/feature",
  name: "feature",
  branch: "feature",
  isMainWorktree: false,
  isCurrent: false,
});

const CORE_READS = [
  "workspace.list",
  "actions.getContext",
  "recipe.list",
  "agent.listPresets",
  "agent.listModels",
  "worktree.waitForPullRequest",
];

/** The `core` reads an orchestrator's loop reaches for, with no window open (#14139). */
describe("core reads with no frontend", () => {
  it.each(CORE_READS)("runs %s on the host rather than refusing it", (id) => {
    expect(Object.hasOwn(VIEWLESS_ACTIONS, id)).toBe(true);
  });

  describe("workspace.list", () => {
    const rows = [
      { workspaceId: "proj-1", path: "/repo", name: "Repo", kind: "project", hasLiveView: false },
      { workspaceId: "scratch-1", path: "/s", name: "S", kind: "scratch", hasLiveView: false },
    ];

    it("answers with main's workspace catalog", async () => {
      const { deps, invoke } = makeDeps();
      invoke.mockImplementation(async (_id, channel) =>
        channel === CHANNELS.WORKSPACE_LIST ? rows : undefined
      );

      const result = await executeViewlessAction(request("workspace.list", undefined), deps);

      expect(result).toEqual({ ok: true, result: { workspaces: rows } });
    });

    it("still needs a registered project, as every other action does", async () => {
      const { deps } = makeDeps();

      expect(
        await executeViewlessAction(
          { ...request("actions.getContext", undefined), workspaceId: "scratch-1" },
          deps
        )
      ).toBeNull();
    });
  });

  describe("actions.getContext", () => {
    it("reports the project, its saved selection and its panels, with nothing focused", async () => {
      const { deps } = makeDeps(
        {
          getWorkspaceHosts: () => makeHosts(),
          getPtyReader: () => makePty({ live: { kind: "terminal" }, gone: { isTrashed: true } }),
        },
        {
          worktrees: [makeWorktree(), FEATURE],
          state: {
            projectId: PROJECT.id,
            sidebarWidth: 350,
            activeWorktreeId: FEATURE.id,
            terminals: [{ id: "saved", kind: "terminal", title: "Shell", location: "grid" }],
          },
        }
      );

      const result = await executeViewlessAction(request("actions.getContext", undefined), deps);

      expect(result).toEqual({
        ok: true,
        result: {
          projectId: PROJECT.id,
          projectName: PROJECT.name,
          projectPath: PROJECT.path,
          activeWorktreeId: FEATURE.id,
          activeWorktreeName: "feature",
          activeWorktreePath: FEATURE.path,
          activeWorktreeBranch: "feature",
          activeWorktreeIsMain: false,
          portalOpen: false,
          portalActiveTabId: null,
          // The saved panel and the live one; the trashed one holds no slot.
          terminalCount: 2,
          worktreeCount: 2,
        },
      });
      const context = (result as { result: Record<string, unknown> }).result;
      expect(context.focusedTerminalId).toBeUndefined();
      expect(context.focusedWorktreeId).toBeUndefined();
    });

    it("fails rather than reporting no worktrees when the workspace host is unavailable", async () => {
      const { deps } = makeDeps();

      const result = await executeViewlessAction(request("actions.getContext", undefined), deps);

      expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
    });

    it("fails rather than reporting no worktrees while the host hasn't classified the folder", async () => {
      const made = makeDeps({ getWorkspaceHosts: () => makeHosts() });
      made.invoke.mockImplementation(async (_id, channel) =>
        channel === CHANNELS.WORKTREE_GET_ALL_WITH_STATUS
          ? { worktrees: [], gitBacked: null }
          : undefined
      );

      const result = await executeViewlessAction(
        request("actions.getContext", undefined),
        made.deps
      );

      expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
    });

    it("prefers the call's own worktree, and reports a stale one without its details", async () => {
      const { deps } = makeDeps(
        { getWorkspaceHosts: () => makeHosts() },
        { worktrees: [makeWorktree(), FEATURE] }
      );

      const own = await executeViewlessAction(
        {
          ...request("actions.getContext", undefined),
          context: { projectId: PROJECT.id, activeWorktreeId: FEATURE.id },
        },
        deps
      );
      expect(own).toMatchObject({ ok: true, result: { activeWorktreeName: "feature" } });

      const stale = await executeViewlessAction(
        {
          ...request("actions.getContext", undefined),
          context: { projectId: PROJECT.id, activeWorktreeId: "/gone" },
        },
        deps
      );
      expect(stale).toMatchObject({ ok: true, result: { activeWorktreeId: "/gone" } });
      expect((stale as { result: Record<string, unknown> }).result.activeWorktreeName).toBe(
        undefined
      );
    });
  });

  describe("recipe.list", () => {
    const recipe = (overrides: Partial<TerminalRecipe>): TerminalRecipe =>
      ({ id: "r", name: "R", terminals: [], createdAt: 0, ...overrides }) as TerminalRecipe;

    function recipeDeps(tiers: {
      global?: TerminalRecipe[];
      project?: TerminalRecipe[];
      inRepo?: TerminalRecipe[];
      plugin?: TerminalRecipe[];
      failing?: string;
    }) {
      const made = makeDeps();
      made.invoke.mockImplementation(async (_id, channel) => {
        if (channel === tiers.failing) throw new Error("unreadable");
        switch (channel) {
          case CHANNELS.GLOBAL_GET_RECIPES:
            return tiers.global ?? [];
          case CHANNELS.PROJECT_GET_RECIPES:
            return { recipes: tiers.project ?? [], collisions: [] };
          case CHANNELS.PROJECT_GET_INREPO_RECIPES:
            return tiers.inRepo ?? [];
          case CHANNELS.PLUGIN_RECIPES_GET:
            return tiers.plugin ?? [];
          default:
            return undefined;
        }
      });
      return made;
    }

    it("merges the four tiers as a view's store does, each with its origin", async () => {
      const { deps } = recipeDeps({
        global: [recipe({ id: "g", name: "Global", terminals: [{ type: "terminal" }] as never })],
        project: [
          recipe({ id: "p", name: "Local", projectId: PROJECT.id, worktreeId: "/repo-wt/a" }),
          // The reconciled mirror of the in-repo recipe below, shown in its place.
          recipe({
            id: "inrepo-team",
            name: "Team",
            projectId: PROJECT.id,
            terminals: [{ type: "terminal" }, { type: "terminal" }] as never,
          }),
        ],
        inRepo: [recipe({ id: "inrepo-team", name: "Team", projectId: PROJECT.id })],
        plugin: [
          recipe({
            id: "acme.tools/setup",
            name: "Setup",
            origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "setup" },
          }),
        ],
      });

      const result = await executeViewlessAction(request("recipe.list", undefined), deps);

      expect(result).toEqual({
        ok: true,
        result: {
          isLoading: false,
          recipes: [
            {
              id: "g",
              name: "Global",
              worktreeId: null,
              terminalCount: 1,
              showInEmptyState: false,
              origin: { kind: "global", pluginId: null },
            },
            {
              id: "acme.tools/setup",
              name: "Setup",
              worktreeId: null,
              terminalCount: 0,
              showInEmptyState: false,
              origin: { kind: "plugin", pluginId: "acme.tools" },
            },
            {
              id: "p",
              name: "Local",
              worktreeId: "/repo-wt/a",
              terminalCount: 0,
              showInEmptyState: false,
              origin: { kind: "project", pluginId: null },
            },
            {
              id: "inrepo-team",
              name: "Team",
              worktreeId: null,
              terminalCount: 2,
              showInEmptyState: false,
              origin: { kind: "team", pluginId: null },
            },
          ],
        },
      });
    });

    it("never honours a provenance a user-owned tier claims", async () => {
      const { deps } = recipeDeps({
        global: [
          recipe({
            id: "forged",
            origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "x" },
          }),
        ],
      });

      const result = await executeViewlessAction(request("recipe.list", undefined), deps);

      expect(result).toMatchObject({
        ok: true,
        result: { recipes: [{ id: "forged", origin: { kind: "global", pluginId: null } }] },
      });
    });

    it("filters to a worktree's own recipes and the unscoped ones", async () => {
      const { deps } = recipeDeps({
        project: [
          recipe({ id: "a", projectId: PROJECT.id, worktreeId: "/repo-wt/a" }),
          recipe({ id: "b", projectId: PROJECT.id, worktreeId: "/repo-wt/b" }),
          recipe({ id: "any", projectId: PROJECT.id }),
        ],
      });

      const result = await executeViewlessAction(
        request("recipe.list", { worktreeId: "/repo-wt/a" }),
        deps
      );

      const ids = (result as { result: { recipes: { id: string }[] } }).result.recipes.map(
        (r) => r.id
      );
      expect(ids).toEqual(["a", "any"]);
    });

    it("still answers when one tier can't be read", async () => {
      const { deps } = recipeDeps({
        global: [recipe({ id: "g" })],
        failing: CHANNELS.PROJECT_GET_RECIPES,
      });

      const result = await executeViewlessAction(request("recipe.list", undefined), deps);

      expect(result).toMatchObject({ ok: true, result: { recipes: [{ id: "g" }] } });
    });

    it("stops before the reconciling read when its standing is gone", async () => {
      const { deps, invoke } = recipeDeps({});
      const refusal = new Error("Another machine drives this project");
      const checkWrite = vi.fn((changed: boolean) => (changed ? null : refusal));
      checkWrite.mockReturnValueOnce(null);

      await expect(
        executeViewlessAction({ ...request("recipe.list", undefined), checkWrite }, deps)
      ).rejects.toBe(refusal);
      expect(invoke.mock.calls.some(([, channel]) => channel === CHANNELS.PROJECT_GET_RECIPES)).toBe(
        false
      );
    });
  });

  describe("agent.listPresets", () => {
    const settings = {
      agents: {
        claude: {
          customPresets: [
            { id: "zai", name: "Z.ai", env: { SECRET: "x" } },
            { id: "kimi", name: "Kimi" },
          ],
        },
      },
    } as unknown as AgentSettings;

    function presetDeps() {
      const made = makeDeps(
        { getPtyReader: () => makePty(), getWorkspaceHosts: () => makeHosts() },
        { worktrees: [makeWorktree()] }
      );
      made.deps.agents.getSettings = async () => settings;
      made.deps.agents.getProjectPresets = async () => ({
        claude: [{ id: "repo", name: "Repo preset" }],
      });
      return made;
    }

    it("lists every source a launch resolves against, identity only", async () => {
      const { deps } = presetDeps();

      const result = await executeViewlessAction(
        request("agent.listPresets", { agentId: "claude" }),
        deps
      );

      if (!result?.ok) throw new Error(JSON.stringify(result));
      const listed = result.result as {
        presetsComplete: boolean;
        presets: { id: string; source: string }[];
      };
      expect(listed.presetsComplete).toBe(true);
      expect(listed.presets.slice(0, 3)).toEqual([
        { id: "zai", name: "Z.ai", source: "custom" },
        { id: "kimi", name: "Kimi", source: "custom" },
        { id: "repo", name: "Repo preset", source: "project" },
      ]);
      expect(JSON.stringify(listed)).not.toContain("SECRET");
    });

    it("names exactly the presets a launch with no view accepts", async () => {
      const { deps } = presetDeps();
      const result = await executeViewlessAction(
        request("agent.listPresets", { agentId: "claude" }),
        deps
      );
      if (!result?.ok) throw new Error(JSON.stringify(result));
      const ids = (result.result as { presets: { id: string }[] }).presets.map((p) => p.id);
      expect(ids.length).toBeGreaterThan(0);

      for (const presetId of [...ids, "not-a-preset"]) {
        const { deps: launch, invoke } = presetDeps();
        await executeViewlessAction(request("agent.launch", { agentId: "claude", presetId }), launch);
        const call = invoke.mock.calls.find(([, channel]) => channel === CHANNELS.TERMINAL_SPAWN);
        const spawned = call?.[2][0] as { agentPresetId?: string } | undefined;
        expect(spawned?.agentPresetId).toBe(presetId === "not-a-preset" ? undefined : presetId);
      }
    });

    it("leaves another project's repository presets out and says the list is incomplete", async () => {
      const { deps } = presetDeps();

      const result = await executeViewlessAction(
        request("agent.listPresets", { agentId: "claude", projectId: "proj-2" }),
        deps
      );

      if (!result?.ok) throw new Error(JSON.stringify(result));
      const listed = result.result as {
        presetsComplete: boolean;
        presets: { source: string }[];
      };
      expect(listed.presetsComplete).toBe(false);
      expect(listed.presets.some((p) => p.source === "project")).toBe(false);
    });

    it("says the list is incomplete when a source can't be read", async () => {
      const { deps } = presetDeps();
      deps.agents.getProjectPresets = async () => {
        throw new Error("unreadable");
      };

      const result = await executeViewlessAction(
        request("agent.listPresets", { agentId: "claude" }),
        deps
      );

      expect(result).toMatchObject({ ok: true, result: { presetsComplete: false } });
    });

    it("lists nothing for an agent a launch would refuse", async () => {
      const { deps } = presetDeps();
      deps.agents.getProjectPresets = async () => ({
        "removed-agent": [{ id: "team", name: "Team" }],
      });

      const listed = await executeViewlessAction(
        request("agent.listPresets", { agentId: "removed-agent" }),
        deps
      );
      expect(listed).toEqual({ ok: true, result: { presetsComplete: true, presets: [] } });

      const launched = await executeViewlessAction(
        request("agent.launch", { agentId: "removed-agent", presetId: "team" }),
        deps
      );
      expect(launched?.ok).toBe(false);
    });

    it("treats an inherited key as no agent", async () => {
      const { deps } = presetDeps();

      const result = await executeViewlessAction(
        request("agent.listPresets", { agentId: "__proto__" }),
        deps
      );

      expect(result).toEqual({ ok: true, result: { presetsComplete: true, presets: [] } });
    });
  });

  describe("agent.listModels", () => {
    function modelDeps() {
      const made = makeDeps();
      made.invoke.mockImplementation(async (_id, channel, args) =>
        channel === CHANNELS.AGENT_CAPABILITIES_GET_RESOLVED_MODEL_LIST
          ? {
              agentId: args[0],
              models: [{ id: `${String(args[0])}-1`, name: "One", contextWindow: 1 }],
              contextWindow: null,
              source: "bundled",
            }
          : undefined
      );
      return made;
    }

    it("answers one agent's models from the host's catalog, ids and names only", async () => {
      const { deps } = modelDeps();

      const result = await executeViewlessAction(
        request("agent.listModels", { agentId: "claude" }),
        deps
      );

      expect(result).toEqual({
        ok: true,
        result: { agents: [{ agentId: "claude", models: [{ id: "claude-1", name: "One" }] }] },
      });
    });

    it("lists every listed agent when none is named", async () => {
      const { deps } = modelDeps();

      const result = await executeViewlessAction(request("agent.listModels", undefined), deps);

      if (!result?.ok) throw new Error(JSON.stringify(result));
      const ids = (result.result as { agents: { agentId: string }[] }).agents.map((a) => a.agentId);
      expect(ids).toContain("claude");
      expect(ids).toContain("codex");
    });

    it("refuses an agent the registry doesn't have", async () => {
      const { deps, invoke } = modelDeps();

      const result = await executeViewlessAction(
        request("agent.listModels", { agentId: "no-such-agent" }),
        deps
      );

      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe("worktree.waitForPullRequest", () => {
    const withPr = makeWorktree({
      ...FEATURE,
      linked: {
        pr: { ref: { number: 42 }, url: "https://forge/pr/42", state: "open" },
      } as never,
    });

    it("answers at once with a PR the host has already detected", async () => {
      const { deps } = makeDeps(
        { getWorkspaceHosts: () => makeHosts() },
        { worktrees: [makeWorktree(), withPr] }
      );

      const result = await executeViewlessAction(
        request("worktree.waitForPullRequest", { worktreeIds: ["/repo", FEATURE.id] }),
        deps
      );

      expect(result).toEqual({
        ok: true,
        result: {
          timedOut: false,
          worktrees: [
            { worktreeId: "/repo", prNumber: null, prUrl: null, prState: null },
            {
              worktreeId: FEATURE.id,
              prNumber: 42,
              prUrl: "https://forge/pr/42",
              prState: "open",
            },
          ],
        },
      });
    });

    it("polls the host until a PR appears", async () => {
      let reads = 0;
      const made = makeDeps({ getWorkspaceHosts: () => makeHosts() });
      made.invoke.mockImplementation(async (_id, channel) => {
        if (channel !== CHANNELS.WORKTREE_GET_ALL_WITH_STATUS) return undefined;
        reads += 1;
        return { worktrees: [reads < 3 ? FEATURE : withPr], gitBacked: true };
      });
      const sleep = vi.fn(async () => {});
      made.deps.sleep = sleep;

      const result = await executeViewlessAction(
        request("worktree.waitForPullRequest", { worktreeIds: [FEATURE.id] }),
        made.deps
      );

      expect(result).toMatchObject({
        ok: true,
        result: { timedOut: false, worktrees: [{ prNumber: 42 }] },
      });
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it("times out without a PR as a result, not a failure", async () => {
      const { deps } = makeDeps(
        { getWorkspaceHosts: () => makeHosts() },
        { worktrees: [FEATURE] }
      );

      const result = await executeViewlessAction(
        request("worktree.waitForPullRequest", { worktreeIds: [FEATURE.id], timeoutMs: 0 }),
        deps
      );

      expect(result).toEqual({
        ok: true,
        result: {
          timedOut: true,
          worktrees: [{ worktreeId: FEATURE.id, prNumber: null, prUrl: null, prState: null }],
        },
      });
    });

    it("refuses an id only on the host's authoritative word", async () => {
      const made = makeDeps({ getWorkspaceHosts: () => makeHosts() }, { worktrees: [FEATURE] });

      const unknown = await executeViewlessAction(
        request("worktree.waitForPullRequest", { worktreeIds: ["/nope"], timeoutMs: 0 }),
        made.deps
      );
      expect(unknown).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
      expect(JSON.stringify(unknown)).not.toContain("/nope");

      made.invoke.mockImplementation(async (_id, channel) =>
        channel === CHANNELS.WORKTREE_GET_ALL_WITH_STATUS
          ? { worktrees: [], gitBacked: null }
          : undefined
      );
      const unclassified = await executeViewlessAction(
        request("worktree.waitForPullRequest", { worktreeIds: ["/nope"], timeoutMs: 0 }),
        made.deps
      );
      expect(unclassified).toMatchObject({ ok: true, result: { timedOut: true } });
    });

    it("holds the renderer's bounds on its arguments", async () => {
      const { deps } = makeDeps({ getWorkspaceHosts: () => makeHosts() });

      for (const args of [
        { worktreeIds: [] },
        { worktreeIds: Array.from({ length: 33 }, (_, i) => `/w${i}`) },
        { worktreeIds: ["/repo"], timeoutMs: 25_001 },
      ]) {
        const result = await executeViewlessAction(
          request("worktree.waitForPullRequest", args),
          deps
        );
        expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
      }
    });
  });
});
