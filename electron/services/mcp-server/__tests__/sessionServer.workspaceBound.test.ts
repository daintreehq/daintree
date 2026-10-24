import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer, VIEWLESS_MAIN_PROCESS_TOOLS } from "../sessionServer.js";
import { MCP_SURFACE_TOOL_ID } from "../surfaceManifest.js";
import { getViewlessHelpBaseManifest } from "../baseManifest.js";
import { VIEWLESS_ACTIONS } from "../../viewless/viewlessActionCatalog.js";
import type { SessionServerDeps } from "../sessionServer.js";
import {
  TIER_NOT_PERMITTED_CODE,
  SESSION_BINDING_GONE,
  NO_FRONTEND_ATTACHED_CODE,
  CONFIRMATION_REQUIRED_CODE,
  WORKSPACE_BINDING_RESOURCE_URI,
} from "../shared.js";
import {
  buildToolInputSchema,
  buildToolOutputSchema,
  ACTIONS_GET_SCHEMA_TOOL_ID,
} from "../tierAuth.js";
import {
  SessionBindingError,
  WorkspaceBindingError,
  NoFrontendAttachedError,
} from "../rendererBridge.js";
import {
  MCP_EXTERNAL_OMITTED_ARGS,
  MCP_EXTERNAL_TIER_TOOLS,
} from "../../../../shared/config/mcpExternalTierAllowlist.js";
import { MCP_EXTERNAL_BASE_MANIFEST } from "../generated/mcpExternalBaseManifest.js";
import {
  CONFIRM_GATED_EXTERNAL_TOOLS,
  listBaseTools,
  callHandler,
  toolErrorPayload,
  fakeSessionStore,
  fakeDeps,
  makeMockTransport,
  callTool,
  listTools,
  makeManifestEntry,
} from "./helpers/sessionServerFixture.js";

describe("workspace-bound external sessions (#11789)", () => {
  const SESSION = "bound-session";
  const WORKSPACE = "ws-a";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A confirm-gated tool that really is on the external allowlist. */
  function recipeRun(): ActionManifestEntry {
    return { ...makeManifestEntry("recipe.run"), kind: "command", danger: "confirm" as const };
  }

  function boundDeps(overrides?: Partial<SessionServerDeps>): SessionServerDeps {
    const sessionStore = fakeSessionStore("external");
    sessionStore.sessionOriginMap.set(SESSION, "external");
    sessionStore.sessionWorkspaceMap.set(SESSION, WORKSPACE);
    return fakeDeps({
      sessionStore,
      workspaceBinding: { kind: "project", workspaceId: WORKSPACE, workspacePath: "/tmp/a" },
      requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list"), recipeRun()]),
      ...overrides,
    });
  }

  function unboundDeps(overrides?: Partial<SessionServerDeps>): SessionServerDeps {
    return fakeDeps({
      sessionStore: fakeSessionStore("external"),
      requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list"), recipeRun()]),
      ...overrides,
    });
  }

  describe("effective surface", () => {
    it("omits the confirm-gated tool from tools/list", async () => {
      const server = createSessionServer(SESSION, boundDeps());
      await server.connect(makeMockTransport());

      const names = (await listTools(server)).tools.map((t) => t.name);

      expect(names).toContain("terminal.list");
      expect(names).not.toContain("recipe.run");
    });

    it("still lists it for an unbound external session", async () => {
      // Binding is opt-in: a client that didn't ask for one keeps the
      // documented focus-following behaviour, dialog and all.
      const server = createSessionServer("unbound", unboundDeps());
      await server.connect(makeMockTransport());

      expect((await listTools(server)).tools.map((t) => t.name)).toContain("recipe.run");
    });

    // The binding ceiling is applied by deleting withheld ids from
    // `permittedActionIds` after the grant union, so a schema lookup must be
    // refused the same way `tools/list` withholds the name — policy included.
    // Handing back a policy here would describe a target this session provably
    // cannot dispatch (#11910).
    it("withholds the schema and policy for the confirm-gated tool", async () => {
      const deps = boundDeps({
        // `actions.getSchema` itself must be in the bound workspace's surface,
        // or the guard that refuses a tool this workspace cannot describe fires
        // before the lookup is ever filtered.
        requestManifest: vi
          .fn()
          .mockResolvedValue([makeManifestEntry(ACTIONS_GET_SCHEMA_TOOL_ID), recipeRun()]),
        dispatchAction: vi.fn().mockResolvedValue({
          result: { ok: true, result: { ok: true, entry: recipeRun(), policy: null, error: null } },
        }),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const res = await callTool(server, {
        name: ACTIONS_GET_SCHEMA_TOOL_ID,
        arguments: { actionId: "recipe.run" },
      });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
        ok: boolean;
        entry: unknown;
        policy: unknown;
        error: { code: string } | null;
      };

      expect(body.ok).toBe(false);
      expect(body.entry).toBeNull();
      expect(body.policy).toBeNull();
      expect(body.error?.code).toBe("NOT_FOUND");
    });

    it("still answers the schema lookup for a tool the binding does not withhold", async () => {
      // Guards the test above against passing for the wrong reason — a bound
      // session that could not answer ANY lookup would satisfy it too.
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockResolvedValue([
            makeManifestEntry(ACTIONS_GET_SCHEMA_TOOL_ID),
            makeManifestEntry("terminal.list"),
            recipeRun(),
          ]),
        dispatchAction: vi.fn().mockResolvedValue({
          result: {
            ok: true,
            result: {
              ok: true,
              entry: makeManifestEntry("terminal.list"),
              policy: null,
              error: null,
            },
          },
        }),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const res = await callTool(server, {
        name: ACTIONS_GET_SCHEMA_TOOL_ID,
        arguments: { actionId: "terminal.list" },
      });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
        ok: boolean;
        policy: { minimumTier: string } | null;
      };

      expect(body.ok).toBe(true);
      expect(body.policy).toMatchObject({ minimumTier: "external" });
    });

    it("omits it from mcp.surface too, so discovery and listing agree", async () => {
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockResolvedValue([
            makeManifestEntry("terminal.list"),
            makeManifestEntry("mcp.surface"),
            recipeRun(),
          ]),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = (await callTool(server, { name: "mcp.surface" })) as {
        structuredContent: { tools: Array<{ id: string }> };
      };

      const ids = result.structuredContent.tools.map((t) => t.id);
      expect(ids).toContain("terminal.list");
      expect(ids).not.toContain("recipe.run");
    });
  });

  describe("pre-dispatch refusal", () => {
    it("refuses a direct call with CONFIRMATION_REQUIRED and never dispatches", async () => {
      const deps = boundDeps();
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "recipe.run", arguments: {} });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("CONFIRMATION_REQUIRED");
      // Never reached a renderer: the refusal is the protocol's, not a dialog
      // rendered into a view nobody is watching.
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("distinguishes itself from the no-window case so a conductor knows not to retry", async () => {
      const server = createSessionServer(SESSION, boundDeps());
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "recipe.run", arguments: {} });
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
        details: { confirmationChannel: string };
        retriable: boolean;
      };

      expect(payload.details.confirmationChannel).toBe("workspace-bound");
      expect(payload.retriable).toBe(false);
    });

    it("audits the refusal", async () => {
      const deps = boundDeps();
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      await callTool(server, { name: "recipe.run", arguments: {} });

      expect(deps.appendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          toolId: "recipe.run",
          sessionId: SESSION,
          tier: "external",
          outcome: {
            kind: "result",
            value: {
              ok: false,
              error: expect.objectContaining({
                code: "CONFIRMATION_REQUIRED",
                details: { confirmationChannel: "workspace-bound" },
              }),
            },
          },
        })
      );
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("beats a live per-tool grant", async () => {
      // Grants widen dispatch past the tier floor. They must not widen past
      // this ceiling — the dialog a grant bypasses is the one nobody can see.
      const deps = boundDeps();
      deps.sessionStore.grantCache.issueGrant(SESSION, "recipe.run");
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "recipe.run", arguments: {} });

      expect(JSON.stringify(result.content)).toContain("CONFIRMATION_REQUIRED");
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("does not burn a native grant use", async () => {
      const deps = boundDeps();
      const grant = deps.sessionStore.grantCache.issueNativeGrant({
        sessionId: SESSION,
        actorId: "help-1",
        actorType: "help-session",
        allowedTools: ["recipe.run"],
        maxUses: 3,
      });
      const peekSpy = vi.spyOn(deps.sessionStore.grantCache, "peekNativeGrant");
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      await callTool(server, { name: "recipe.run", arguments: {} });

      // recipe.run is ON the external allowlist, so this is the tier-PERMITTED
      // leg — which #11878 newly routes through the native peek. The
      // workspace-bound refusal is a hard ceiling that still returns before
      // the consume site, so the peek must not cost the grant anything.
      expect(peekSpy).toHaveBeenCalledWith(SESSION, "recipe.run");
      expect(deps.sessionStore.grantCache.getNativeGrant(grant.id)?.remainingUses).toBe(3);
    });

    it("refuses a statically-safe action whose args elevate it to confirm (#11860)", async () => {
      // `worktree.createWithRecipe` is on the external allowlist and declares
      // `danger: "safe"`, so it clears the withheld set — but a call carrying a
      // `recipeId` is elevated host-side and would raise a dialog in a view
      // nobody is watching. The static withhold can't see that; the args can.
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockResolvedValue([
            makeManifestEntry("terminal.list"),
            makeManifestEntry("worktree.createWithRecipe"),
          ]),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, {
        name: "worktree.createWithRecipe",
        arguments: { branchName: "feat/x", recipeId: "r1" },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("CONFIRMATION_REQUIRED");
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("still dispatches that action when the args name no recipe", async () => {
      // The elevation is per-dispatch, so the refusal has to be too: gating the
      // action id would block every plain worktree creation.
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockResolvedValue([
            makeManifestEntry("terminal.list"),
            makeManifestEntry("worktree.createWithRecipe"),
          ]),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, {
        name: "worktree.createWithRecipe",
        arguments: { branchName: "feat/x" },
      });

      expect(result.isError).toBeFalsy();
      expect(deps.dispatchAction).toHaveBeenCalled();
    });

    it("refuses a terminal.new whose launch arguments elevate it (#12216)", async () => {
      // Same shape as the recipe case and the same reason: `terminal.new` is on
      // the external allowlist, declares `danger: "safe"` and carries no
      // `recipeId`, so it escapes both existing arms — and a call naming a
      // `command` or a `cwd` is elevated host-side into a dialog raised in a
      // background workspace nobody is watching.
      for (const args of [{ command: "rm -rf /tmp/x" }, { cwd: "/repo/feature" }]) {
        const deps = boundDeps({
          requestManifest: vi
            .fn()
            .mockResolvedValue([
              makeManifestEntry("terminal.list"),
              makeManifestEntry("terminal.new"),
            ]),
        });
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        const result = await callTool(server, { name: "terminal.new", arguments: args });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("CONFIRMATION_REQUIRED");
        expect(deps.dispatchAction).not.toHaveBeenCalled();
      }
    });

    it("still opens a plain terminal in a bound session", async () => {
      // Per-dispatch, so a `terminal.new` naming no launch target keeps working
      // — refusing the action id would take "open a terminal" off the bound
      // surface entirely.
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockResolvedValue([
            makeManifestEntry("terminal.list"),
            makeManifestEntry("terminal.new"),
          ]),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "terminal.new", arguments: {} });

      expect(result.isError).toBeFalsy();
      expect(deps.dispatchAction).toHaveBeenCalled();
    });

    it("leaves the rest of the bound surface dispatchable", async () => {
      const deps = boundDeps();
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "terminal.list", arguments: {} });

      expect(result.isError).toBeFalsy();
      expect(deps.dispatchAction).toHaveBeenCalled();
    });

    it("refuses an action the resolved manifest does not describe", async () => {
      // A stale or partial manifest that omits a newly confirm-gated action
      // would otherwise let exactly the call this guard exists to refuse
      // through to a renderer nobody is watching. Unknown danger is not safe.
      const deps = boundDeps({
        requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list")]),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "recipe.run", arguments: {} });

      expect(result.isError).toBe(true);
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("still runs main-process tools, which return before the renderer check", async () => {
      const deps = boundDeps({
        requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list")]),
        handleSkillsSearch: vi.fn(() => ({ skills: [] })),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "skills.search", arguments: { query: "x" } });

      expect(result.isError).toBeFalsy();
    });

    describe("reaching a workspace with no live view (#12316)", () => {
      // The bug: view residency is an LRU capped at 5, so an orchestrator across
      // dozens of projects held a binding for each and a live view for almost
      // none — and the ceiling refused every call, including the ones that were
      // never going to reach a renderer.
      function viewlessDeps(overrides?: Partial<SessionServerDeps>): SessionServerDeps {
        return boundDeps({
          requestManifest: vi
            .fn()
            .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found")),
          getCachedManifest: vi.fn(() => null),
          ...overrides,
        });
      }

      // Arguments and the dep each tool's execution lands in, keyed by the
      // production set below rather than restated beside it.
      const MAIN_PROCESS_CALLS: Record<
        string,
        {
          args: Record<string, unknown>;
          handler?: keyof SessionServerDeps;
          /** An owned tool answers only for a panel the session created. */
          ownsTerminal?: string;
        }
      > = {
        "terminal.waitUntilIdle": {
          args: { terminalId: "t-1" },
          handler: "handleWaitUntilIdle",
        },
        "terminal.waitUntilIdleBatch": {
          args: { terminalIds: ["t-1"] },
          handler: "handleWaitUntilIdleBatch",
        },
        "skills.search": { args: { query: "x" }, handler: "handleSkillsSearch" },
        "skills.load": { args: { id: "s-1" }, handler: "handleSkillsLoad" },
        // Built here from the manifest rather than through an injected handler.
        "mcp.surface": { args: {} },
        "project.runCheck": {
          args: { projectId: "p-1", runnerId: "test" },
          handler: "handleProjectRunCheck",
        },
        "project.runCommand": {
          args: { projectId: "p-1", command: "git status" },
          handler: "handleProjectRunCommand",
        },
        "terminal.readLastMessageOwned": {
          args: { terminalId: "t-1" },
          handler: "handleTerminalReadLastMessageOwned",
          ownsTerminal: "t-1",
        },
        // Executed through the injected notify service rather than a named dep.
        "terminal.notifyWhenIdle": { args: { terminalId: "t-1" } },
        // Executed through main's assistant control, for an assistant caller (#13496).
        "assistant.list": { args: {} },
        "assistant.start": { args: {} },
        "agent.readQuota": { args: {} },
      };

      function viewlessDepsFor(name: string): SessionServerDeps {
        const deps = viewlessDeps();
        const owned = MAIN_PROCESS_CALLS[name]!.ownsTerminal;
        if (owned !== undefined) {
          deps.sessionStore.resourceOwnership.record(SESSION, [{ kind: "terminal", id: owned }]);
        }
        return deps;
      }

      it("covers every tool the production bypass set names", () => {
        // The guard below is only a drift guard if the cases come from the set
        // itself. Restating the ids would let a tool be added to the bypass —
        // the direction that matters — with no test case at all.
        expect(new Set(Object.keys(MAIN_PROCESS_CALLS))).toEqual(
          new Set(VIEWLESS_MAIN_PROCESS_TOOLS)
        );
      });

      it("lists every one of them, and every action the host runs, to a help session with no view (#13511)", () => {
        const listed = new Set(getViewlessHelpBaseManifest().map((entry) => entry.id));
        expect(
          [...VIEWLESS_MAIN_PROCESS_TOOLS, ...Object.keys(VIEWLESS_ACTIONS)].filter(
            (id) => !listed.has(id)
          )
        ).toEqual([]);
      });

      // The bypass widens reachability, never authority — the tier gate runs
      // first and is untouched. `project.runCheck` is in the set and off the
      // external tier, so it proves that directly: it is refused here for the
      // reason it always was, not because a view is missing.
      const externalTierTools = new Set<string>(MCP_EXTERNAL_TIER_TOOLS);
      const eachMainProcessTool = it.each(
        [...VIEWLESS_MAIN_PROCESS_TOOLS].map((name) => [name] as const)
      );

      eachMainProcessTool("does not need a live view to settle %s", async (name) => {
        const { args, handler } = MAIN_PROCESS_CALLS[name]!;
        const deps = viewlessDepsFor(name);
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        const result = await callTool(server, { name, arguments: args });

        if (externalTierTools.has(name)) {
          // Success, not merely "not a binding error" — an unrelated refusal
          // would satisfy the weaker assertion while proving the opposite.
          expect(result.isError).toBeFalsy();
          if (handler) expect(deps[handler]).toHaveBeenCalled();
        } else {
          expect(toolErrorPayload(result).code).toBe(TIER_NOT_PERMITTED_CODE);
          if (handler) expect(deps[handler]).not.toHaveBeenCalled();
        }
        // Either way, the answer is never "your workspace has no view", and
        // nothing was routed at a renderer.
        expect(JSON.stringify(result.content)).not.toContain(SESSION_BINDING_GONE);
        expect(deps.dispatchAction).not.toHaveBeenCalled();
      });

      eachMainProcessTool("does not resolve the bound manifest to admit %s", async (name) => {
        // The ceiling asked the manifest a question about renderer dispatch.
        // A tool that never reaches a renderer should not pay for the answer.
        const deps = viewlessDepsFor(name);
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        await callTool(server, { name, arguments: MAIN_PROCESS_CALLS[name]!.args });

        if (name !== MCP_SURFACE_TOOL_ID) {
          // `mcp.surface` resolves a manifest for its own report, and falls
          // back to the host base surface when the workspace is unreachable.
          expect(deps.requestManifest).not.toHaveBeenCalled();
        }
      });

      it("still refuses a renderer action with no live view", async () => {
        const deps = viewlessDeps();
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        const result = await callTool(server, { name: "terminal.list", arguments: {} });

        expect(result.isError).toBe(true);
        expect(toolErrorPayload(result).code).toBe(SESSION_BINDING_GONE);
        expect(deps.dispatchAction).not.toHaveBeenCalled();
      });

      it("still refuses a confirm-gated action with no live view", async () => {
        // The bypass must not become a way around the ceiling: nobody is
        // watching this workspace to approve a dialog either way.
        const deps = viewlessDeps();
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        const result = await callTool(server, { name: "recipe.run", arguments: {} });

        expect(result.isError).toBe(true);
        // Refused by the ceiling's fail-closed arm: with no reachable manifest
        // there is no evidence about `danger`, and proceeding would turn a
        // refusal into an unattended dispatch. `SESSION_BINDING_GONE` rather
        // than `CONFIRMATION_REQUIRED` is therefore the honest code — the
        // bypass did not give this action a way past either.
        expect(toolErrorPayload(result).code).toBe(SESSION_BINDING_GONE);
        expect(deps.dispatchAction).not.toHaveBeenCalled();
      });

      it("answers terminal.getStatus from the pty-host when ids are named", async () => {
        const handleTerminalGetStatusViewless = vi.fn().mockResolvedValue({
          terminals: [{ terminalId: "t-1", agentId: "claude", agentState: "working" }],
          source: "pty",
          unavailableFields: ["armed", "lastCheckResult", "exitCode"],
        });
        const deps = viewlessDeps({ handleTerminalGetStatusViewless });
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        const result = await callTool(server, {
          name: "terminal.getStatus",
          arguments: { terminalIds: ["t-1"] },
        });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ source: "pty" });
        // Answered for the workspace the routing itself tried to reach, never
        // one named by the caller.
        expect(handleTerminalGetStatusViewless).toHaveBeenCalledWith(
          { terminalIds: ["t-1"] },
          WORKSPACE
        );
        expect(deps.dispatchAction).not.toHaveBeenCalled();
      });

      it("prefers the renderer for terminal.getStatus whenever a view is live", async () => {
        // The fallback is reduced — no `armed`, no parsed check result — so it
        // must never displace the full answer.
        const handleTerminalGetStatusViewless = vi.fn();
        const deps = boundDeps({
          requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.getStatus")]),
          handleTerminalGetStatusViewless,
        });
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        await callTool(server, {
          name: "terminal.getStatus",
          arguments: { terminalIds: ["t-1"] },
        });

        expect(handleTerminalGetStatusViewless).not.toHaveBeenCalled();
        expect(deps.dispatchAction).toHaveBeenCalled();
      });

      it("refuses a filter-only terminal.getStatus, and says which shape works", async () => {
        // `location` is a panel concept with no pty-host meaning, so answering
        // the fleet path from the inventory would quietly redefine it.
        const handleTerminalGetStatusViewless = vi.fn();
        const deps = viewlessDeps({ handleTerminalGetStatusViewless });
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        const result = await callTool(server, {
          name: "terminal.getStatus",
          arguments: { location: "grid" },
        });

        const payload = toolErrorPayload(result);
        expect(payload.code).toBe(SESSION_BINDING_GONE);
        expect(payload.retriable).toBe(true);
        // And it names the shape that would have worked, so a poller is not
        // left retrying the one that never can.
        expect(JSON.stringify(result.content)).toContain("terminalIds");
        expect(handleTerminalGetStatusViewless).not.toHaveBeenCalled();
      });

      it("does not fall back for an ambiguous workspace", async () => {
        // Two views is a conflict the user has to resolve; answering anyway
        // would hide it.
        const handleTerminalGetStatusViewless = vi.fn();
        const deps = viewlessDeps({
          requestManifest: vi
            .fn()
            .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "ambiguous")),
          handleTerminalGetStatusViewless,
        });
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        const result = await callTool(server, {
          name: "terminal.getStatus",
          arguments: { terminalIds: ["t-1"] },
        });

        expect(toolErrorPayload(result).code).toBe(SESSION_BINDING_GONE);
        // And it does not hand out the id advice, which cannot resolve a
        // duplicate view.
        expect(JSON.stringify(result.content)).not.toContain("terminalIds");
        expect(handleTerminalGetStatusViewless).not.toHaveBeenCalled();
      });

      it("does not fall back for a destroyed pin", async () => {
        // Not a route that comes back — the session's identity is gone.
        const handleTerminalGetStatusViewless = vi.fn();
        const deps = viewlessDeps({
          requestManifest: vi.fn().mockRejectedValue(new SessionBindingError(99)),
          handleTerminalGetStatusViewless,
        });
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        const result = await callTool(server, {
          name: "terminal.getStatus",
          arguments: { terminalIds: ["t-1"] },
        });

        const payload = toolErrorPayload(result);
        expect(payload.code).toBe(SESSION_BINDING_GONE);
        expect(payload.retriable).toBe(false);
        expect(handleTerminalGetStatusViewless).not.toHaveBeenCalled();
      });
    });

    it("keeps refusing after teardown clears the session's workspace map", async () => {
      // Routing captures the binding once; the surface policy must share that
      // lifetime, or a torn-down session loses its ceiling while its dispatch
      // closure still targets the bound workspace.
      const deps = boundDeps();
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());
      deps.sessionStore.sessionWorkspaceMap.delete(SESSION);

      const result = await callTool(server, { name: "recipe.run", arguments: {} });

      expect(JSON.stringify(result.content)).toContain("CONFIRMATION_REQUIRED");
      // And the message names the workspace, not `undefined`.
      expect(JSON.stringify(result.content)).toContain(WORKSPACE);
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it.each([["not-found" as const], ["ambiguous" as const]])(
      "reports a %s workspace as retriable rather than a dead end (#12082)",
      async (reason) => {
        // The published surface is only honest if the failure it defers to says
        // "try again once the workspace is open". A conductor that gives up
        // permanently on a condition the user is about to fix is the same bug
        // one layer down from the terminal handshake this replaced.
        const deps = boundDeps({
          requestManifest: vi.fn().mockRejectedValue(new WorkspaceBindingError(WORKSPACE, reason)),
          getCachedManifest: vi.fn(() => null),
        });
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        const result = await callTool(server, { name: "terminal.list", arguments: {} });

        expect(result.isError).toBe(true);
        const payload = toolErrorPayload(result);
        expect(payload.code).toBe(SESSION_BINDING_GONE);
        expect(payload.retriable).toBe(true);
        // Fail-closed is unchanged: the call routed nowhere, least of all to
        // the focused window.
        expect(deps.dispatchAction).not.toHaveBeenCalled();
      }
    );

    it("keeps a destroyed pinned view non-retriable under the same error code", async () => {
      const deps = boundDeps({
        requestManifest: vi.fn().mockRejectedValue(new SessionBindingError(99)),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "terminal.list", arguments: {} });

      const payload = toolErrorPayload(result);
      expect(payload.code).toBe(SESSION_BINDING_GONE);
      expect(payload.retriable).toBe(false);
    });
  });

  describe("binding failures and metadata", () => {
    it.each([["not-found" as const], ["ambiguous" as const]])(
      "serves the host base surface from tools/list when the workspace is %s",
      async (reason) => {
        // Completing the handshake buys nothing if discovery then answers
        // "permanently no tools" (#12082) — that is harder to diagnose than the
        // 400 it replaced. The workspace is reachable again the moment the user
        // opens it, so discovery describes the surface and the per-call route
        // reports reachability.
        const deps = boundDeps({
          requestManifest: vi.fn().mockRejectedValue(new WorkspaceBindingError(WORKSPACE, reason)),
          getCachedManifest: vi.fn(() => null),
        });
        const server = createSessionServer(SESSION, deps);
        await server.connect(makeMockTransport());

        const tools = await listBaseTools(server);
        const ids = new Set(tools.map((t) => t.name));

        // Derived from the allowlist rather than a copied list, so a tool added
        // to the external tier is covered here the day it lands.
        const expected = MCP_EXTERNAL_TIER_TOOLS.filter(
          (id) => !CONFIRM_GATED_EXTERNAL_TOOLS.has(id)
        );
        expect(ids).toEqual(new Set(expected));
        expect(tools.length).toBeGreaterThan(0);
      }
    );

    it("publishes the input schemas a client needs to call the base surface", async () => {
      // The whole reason for a full surface rather than an empty one plus a
      // later notification: the client can call what it sees, with no
      // cooperation required from it.
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found")),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const tools = await listBaseTools(server);
      // Every exposed tool, not a sample: "at least one tool has at least one
      // parameter" would still pass with every other schema dropped in the
      // plumbing between the artifact and the wire.
      for (const tool of tools) {
        const source = MCP_EXTERNAL_BASE_MANIFEST.find((e) => e.id === tool.name);
        expect(source).toBeDefined();
        // The same projection an api-key session is listed with.
        expect(tool.inputSchema).toEqual(
          buildToolInputSchema(source!, MCP_EXTERNAL_OMITTED_ARGS[source!.id])
        );
        expect(tool.outputSchema).toEqual(buildToolOutputSchema(source!));
      }
      // Premise: the loop is vacuous on an empty listing, and several of these
      // tools genuinely take arguments.
      expect(
        tools.filter((t) => Object.keys(t.inputSchema?.properties ?? {}).length > 0).length
      ).toBeGreaterThan(1);
    });

    it("answers mcp.surface from the base surface, agreeing with tools/list", async () => {
      // `mcp.surface` runs entirely in main and never reaches a renderer, so
      // the bound ceiling no longer refuses it for a workspace with no view
      // (#12316). It then resolves its own manifest through `resolveManifest`,
      // which already falls back to the host base surface — so the report and
      // the listing describe one manifest rather than disagreeing about
      // whether this session has any tools at all.
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found")),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "mcp.surface", arguments: {} });
      const listed = new Set((await listBaseTools(server)).map((t) => t.name));

      expect(result.isError).toBeFalsy();
      // Set equality, not containment: a report that named every listed tool
      // *plus* a withheld one would satisfy the weaker check while describing
      // exactly the surface the ceiling exists to keep off this session.
      const reported = new Set(
        (result.structuredContent as { tools: Array<{ id: string }> }).tools.map((t) => t.id)
      );
      expect(reported).toEqual(listed);
      expect(listed.size).toBeGreaterThan(0);
    });

    it("never serves a cached manifest after a binding failure", async () => {
      // A cached manifest describes a view this session can no longer reach, so
      // serving it would answer with another workspace's tool surface. The host
      // base surface is not that — it comes from the action registry and
      // describes nobody's view — so the tell is whose *copy* of a shared id
      // came back, not whether the id appears at all: an id-only assertion
      // would pass on the tier allowlist alone and prove nothing.
      const sentinel = makeManifestEntry("terminal.list");
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "ambiguous")),
        getCachedManifest: vi.fn(() => [sentinel]),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const served = (await listBaseTools(server)).find((t) => t.name === "terminal.list");
      expect(served?.description).not.toBe(sentinel.description);
      expect(served?.description).toBe(
        MCP_EXTERNAL_BASE_MANIFEST.find((e) => e.id === "terminal.list")?.description
      );
    });

    it("reports an unreachable workspace on a resource read rather than answering as if it were empty", async () => {
      // `tools/list` gets a host surface because the tool *set* is knowable
      // without a view; a resource read is not — it reads what is actually open
      // in that workspace. Answering emptily would be an authoritative "you
      // have nothing", the same lie the terminal handshake told.
      //
      // `scrollback` is backed by `terminal.getOutput`, which the external tier
      // permits — a `pulse` URI would be refused as TIER_NOT_PERMITTED before
      // dispatch and never reach the binding at all.
      const deps = boundDeps({
        dispatchAction: vi
          .fn()
          .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found")),
        requestManifest: vi
          .fn()
          .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found")),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      await expect(
        callHandler(server, "resources/read", { uri: "daintree://terminal/t-1/scrollback" })
      ).rejects.toMatchObject({
        data: { code: SESSION_BINDING_GONE, retriable: true, errorCategory: "business" },
      });
    });

    it("answers resources/list with the binding resource instead of refusing outright (#12313)", async () => {
      // The refusal above used to cover `resources/list` too, on the reasoning
      // that an empty listing is an authoritative "you have nothing". That
      // reasoning still holds — what changed is that the listing is no longer
      // empty. It leads with the binding resource, so dropping the categories
      // that needed a renderer is not a claim about the workspace's contents:
      // the client is handed the thing that says the route is gone.
      //
      // It has to be `resources/list` specifically that recovers, because a
      // bound session with no view cannot call anything else — refusing here
      // left it knowing it was evicted with nothing to ask.
      const deps = boundDeps({
        dispatchAction: vi
          .fn()
          .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found")),
        requestManifest: vi
          .fn()
          .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found")),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const listed = (await callHandler(server, "resources/list", {})) as {
        resources: Array<{ uri: string }>;
      };
      const uris = listed.resources.map((r) => r.uri);

      // Asserted whole rather than by absence: a listing that degraded the
      // dispatch-backed categories but fabricated an entry in their place would
      // satisfy any "does not contain" check while telling the same lie.
      expect(uris).toEqual([WORKSPACE_BINDING_RESOURCE_URI]);
    });

    it("serves the binding resource without dispatching or probing the route (#12313)", async () => {
      // The exemption the issue asked for, obtained by construction rather than
      // by a special case: this read touches no renderer, so there is no route
      // for a residency probe to be protecting. If it ever grew a dispatch it
      // would start failing exactly when it is needed most.
      const dispatchAction = vi
        .fn()
        .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found"));
      const deps = boundDeps({
        dispatchAction,
        requestManifest: vi
          .fn()
          .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found")),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const read = (await callHandler(server, "resources/read", {
        uri: WORKSPACE_BINDING_RESOURCE_URI,
      })) as { contents: Array<{ text: string; mimeType: string }> };

      expect(dispatchAction).not.toHaveBeenCalled();
      // A residency probe would resolve through `requestManifest`, so an
      // untouched manifest is what proves the exemption is structural rather
      // than a branch that could be reordered back into the path — the check
      // that keeps standing now that #12316 removed the probe itself.
      expect(deps.requestManifest).not.toHaveBeenCalled();
      const state = JSON.parse(read.contents[0].text);
      expect(state.workspaceId).toBe(WORKSPACE);
      expect(state.routeState).toBe("not-found");
      expect(state.liveViewCount).toBe(0);
      expect(state.keepResident).toBe(false);
    });

    it("answers `unbound` for a session with no binding rather than borrowing a workspace", async () => {
      // The failure this guards is argument mis-wiring: a reader handed the
      // focused workspace, or a stale one from another session, would look
      // right in every bound test and be exactly the cross-workspace answer the
      // binding exists to refuse (#7003).
      const server = createSessionServer("unbound-session", unboundDeps());
      await server.connect(makeMockTransport());

      const read = (await callHandler(server, "resources/read", {
        uri: WORKSPACE_BINDING_RESOURCE_URI,
      })) as { contents: Array<{ text: string }> };

      const state = JSON.parse(read.contents[0].text);
      expect(state.workspaceId).toBeNull();
      expect(state.routeState).toBe("unbound");
    });

    it("installs and tears down a real subscription to the binding resource", async () => {
      // `pulse` and `agentState` were the only subscribable kinds; a client that
      // must poll to notice its workspace returning is the case the issue calls
      // out, so the push half has to exist even though it is best effort.
      //
      // Asserted through the session's subscription bucket rather than the `{}`
      // acknowledgement: returning `{}` without installing anything would
      // satisfy the acknowledgement while the client waited forever. The
      // unsubscribe is also load-bearing here — the listener lives on a
      // process-global registry, so a test that only subscribes leaks one into
      // every case that runs after it.
      const deps = boundDeps();
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      await callHandler(server, "resources/subscribe", { uri: WORKSPACE_BINDING_RESOURCE_URI });
      expect(
        deps.sessionStore.resourceSubscriptions.get(SESSION)?.has(WORKSPACE_BINDING_RESOURCE_URI)
      ).toBe(true);

      await callHandler(server, "resources/unsubscribe", { uri: WORKSPACE_BINDING_RESOURCE_URI });
      // `?? false` because an emptied bucket is dropped from the map entirely,
      // so "no bucket" and "bucket without this uri" are the same answer here.
      expect(
        deps.sessionStore.resourceSubscriptions.get(SESSION)?.has(WORKSPACE_BINDING_RESOURCE_URI) ??
          false
      ).toBe(false);
    });

    it("refuses a binding URI naming another workspace", async () => {
      // `current` is the only id this resource takes. Rejecting at the parse
      // step means no URI shape can reach the reader asking about a workspace
      // the session is not bound to.
      const server = createSessionServer(SESSION, boundDeps());
      await server.connect(makeMockTransport());

      await expect(
        callHandler(server, "resources/read", { uri: `daintree://workspace/${WORKSPACE}/binding` })
      ).rejects.toThrow(/Unknown resource URI/);
    });

    it("still refuses resources/list for a dead pin, which has no later state to recover into", async () => {
      // A `SessionBindingError` is a destroyed WebContents the session can never
      // re-resolve — unlike a workspace, which comes back when the user reopens
      // it. Degrading the listing there would promise a recovery that cannot
      // happen, so narrowing the fallback to `WorkspaceBindingError` is
      // load-bearing rather than incidental.
      const deps = boundDeps({
        dispatchAction: vi.fn().mockRejectedValue(new SessionBindingError(1234)),
        requestManifest: vi.fn().mockRejectedValue(new SessionBindingError(1234)),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      await expect(callHandler(server, "resources/list", {})).rejects.toMatchObject({
        data: { code: SESSION_BINDING_GONE },
      });
    });

    it.each([["resources/read"], ["resources/subscribe"]])(
      "serves %s for host-global agent state whether or not the workspace has a view",
      async (method) => {
        // `agentState` is the one resource with no backing dispatch — it reads
        // the process-global agent store with no renderer involved, so view
        // residency was never evidence about it (#12316). The probe #12082
        // added closed only half of a gap it could not close: which workspace
        // an agent belongs to is unchecked either way, and a bound session with
        // a live view could always read across it. That is #11789's own scoping
        // work, and it has to apply to both cases.
        const reachable = boundDeps({
          requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list")]),
          getCachedManifest: vi.fn(() => null),
        });
        const unreachable = boundDeps({
          requestManifest: vi
            .fn()
            .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found")),
          getCachedManifest: vi.fn(() => null),
        });

        for (const deps of [reachable, unreachable]) {
          const server = createSessionServer(SESSION, deps);
          await server.connect(makeMockTransport());
          await expect(
            callHandler(server, method, { uri: "daintree://agent/agent-1/state" })
          ).resolves.toBeDefined();
        }
        // And the read cost no manifest resolution at all.
        expect(unreachable.requestManifest).not.toHaveBeenCalled();
      }
    );

    it("still degrades a resource listing gracefully for an ordinary dispatch failure", async () => {
      // The rethrow above is scoped to route-binding failures; a flaky
      // enumeration must keep returning a partial listing rather than failing
      // the whole request.
      const deps = boundDeps({
        dispatchAction: vi.fn().mockRejectedValue(new Error("renderer hiccup")),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      await expect(callHandler(server, "resources/list", {})).resolves.toMatchObject({
        resources: expect.any(Array),
      });
    });

    it("still fails tools/list closed for a destroyed pinned view", async () => {
      // A dead pin is the session's identity, not a route it can re-resolve, so
      // there is no later state in which this succeeds — and no host surface to
      // stand in for a window that is gone.
      const deps = boundDeps({
        requestManifest: vi.fn().mockRejectedValue(new SessionBindingError(77)),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      await expect(listTools(server)).rejects.toMatchObject({
        data: { code: SESSION_BINDING_GONE, retriable: false, errorCategory: "business" },
      });
    });

    it("still falls back to the cache for an ordinary transient fetch failure", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const deps = boundDeps({
        requestManifest: vi.fn().mockRejectedValue(new Error("Manifest request timed out")),
        getCachedManifest: vi.fn(() => [makeManifestEntry("terminal.list")]),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      expect((await listTools(server)).tools.map((t) => t.name)).toEqual(["terminal.list"]);
    });

    it("advertises the resolved binding in the initialize capabilities", async () => {
      const server = createSessionServer(SESSION, boundDeps());
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const capabilities = client.getServerCapabilities();
        expect(capabilities?.experimental?.["org.daintree/workspace-binding"]).toEqual({
          kind: "project",
          workspaceId: WORKSPACE,
          workspacePath: "/tmp/a",
        });
        // Declaring it at construction must not cost the SDK's own initialize
        // handling — client capability capture still has to work.
        expect(server.getClientCapabilities()).toBeDefined();
      } finally {
        await client.close();
      }
    });

    it("advertises no binding capability for an unbound session", async () => {
      const server = createSessionServer("unbound", unboundDeps());
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        expect(
          client.getServerCapabilities()?.experimental?.["org.daintree/workspace-binding"]
        ).toBeUndefined();
      } finally {
        await client.close();
      }
    });
  });
});

describe("no frontend attached to a bound workspace", () => {
  const SESSION = "headless-session";
  const WORKSPACE = "ws-headless";

  function headlessDeps(
    tier: "external" | "core",
    overrides?: Partial<SessionServerDeps>
  ): SessionServerDeps {
    const sessionStore = fakeSessionStore(tier);
    sessionStore.sessionWorkspaceMap.set(SESSION, WORKSPACE);
    return fakeDeps({
      sessionStore,
      workspaceBinding: { kind: "project", workspaceId: WORKSPACE, workspacePath: "/tmp/h" },
      getCachedManifest: vi.fn(() => null),
      requestManifest: vi.fn().mockRejectedValue(new NoFrontendAttachedError(WORKSPACE)),
      ...overrides,
    });
  }

  it("lets a bound external session reach a host-runnable action instead of refusing the route", async () => {
    const dispatchAction = vi.fn().mockResolvedValue({
      result: { ok: true, result: { terminalId: "t-headless" } },
    });
    const server = createSessionServer(SESSION, headlessDeps("external", { dispatchAction }));
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "terminal.new", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(dispatchAction).toHaveBeenCalledWith("terminal.new", {}, false);
    expect(JSON.stringify(result.content)).toContain("t-headless");
  });

  it("still refuses a launch argument that would need a confirmation nobody can give", async () => {
    const dispatchAction = vi.fn();
    const server = createSessionServer(SESSION, headlessDeps("external", { dispatchAction }));
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "terminal.new",
      arguments: { command: "rm -rf build" },
    });

    expect(result.isError).toBe(true);
    expect(toolErrorPayload(result).code).toBe(CONFIRMATION_REQUIRED_CODE);
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("answers NO_FRONTEND_ATTACHED, retriably, for an action only a frontend can run", async () => {
    const dispatchAction = vi
      .fn()
      .mockRejectedValue(new NoFrontendAttachedError(WORKSPACE, "terminal.rename"));
    const server = createSessionServer(SESSION, headlessDeps("core", { dispatchAction }));
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "terminal.rename",
      arguments: { terminalId: "t-1" },
    });

    expect(result.isError).toBe(true);
    const payload = toolErrorPayload(result);
    expect(payload.code).toBe(NO_FRONTEND_ATTACHED_CODE);
    expect(payload.retriable).toBe(true);
    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("keeps SESSION_BINDING_GONE for a route that was lost rather than never attached", async () => {
    const dispatchAction = vi
      .fn()
      .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found"));
    const server = createSessionServer(
      SESSION,
      headlessDeps("core", {
        dispatchAction,
        requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.rename")]),
      })
    );
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "terminal.rename",
      arguments: { terminalId: "t-1" },
    });

    expect(toolErrorPayload(result).code).toBe(SESSION_BINDING_GONE);
  });

  it("serves the host base surface at discovery when nothing is attached", async () => {
    const server = createSessionServer(SESSION, headlessDeps("external"));
    await server.connect(makeMockTransport());

    const names = (await listTools(server)).tools.map((t) => t.name);

    expect(names).toContain("terminal.new");
  });
});
