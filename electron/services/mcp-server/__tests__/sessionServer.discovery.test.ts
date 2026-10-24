import { afterEach, describe, expect, it, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";
import { BUILT_IN_ACTION_IDS } from "../../../../shared/config/actionIds.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer } from "../sessionServer.js";
import type { SessionServerDeps } from "../sessionServer.js";
import { GrantCache } from "../grantCache.js";
import {
  TIER_NOT_PERMITTED_CODE,
  RESOLVED_WORKSPACE_META_KEY,
  MCP_ASSISTANT_SERVER_INSTRUCTIONS,
  MCP_SERVER_INSTRUCTIONS,
  MCP_SERVER_INSTRUCTIONS_MAX_BYTES,
  TIER_ALLOWLISTS,
} from "../shared.js";
import type { DispatchedWorkspaceRef } from "../shared.js";
import {
  isTierPermitted,
  shouldExposeTool,
  ACTIONS_SEARCH_TOOL_ID,
  ACTIONS_GET_SCHEMA_TOOL_ID,
} from "../tierAuth.js";
import { events } from "../../events.js";
import {
  toolErrorPayload,
  fakeSessionStore,
  fakeDeps,
  makeMockTransport,
  callTool,
  listTools,
  initializeClient,
  makeManifestEntry,
} from "./helpers/sessionServerFixture.js";

describe("sessionServer initialize instructions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers the instructions to a client that completes a real handshake", async () => {
    const server = createSessionServer("session-instructions", fakeDeps());

    await expect(initializeClient(server)).resolves.toBe(MCP_SERVER_INSTRUCTIONS);
  });

  it("sends Daintree's own assistant the short instructions, and every other session the full ones", async () => {
    const help = fakeSessionStore("core");
    help.sessionOriginMap.set("session-help", "help" as never);
    await expect(
      initializeClient(createSessionServer("session-help", fakeDeps({ sessionStore: help })))
    ).resolves.toBe(MCP_ASSISTANT_SERVER_INSTRUCTIONS);
    const pane = fakeSessionStore("core");
    pane.sessionOriginMap.set("session-pane", "external" as never);
    await expect(
      initializeClient(createSessionServer("session-pane", fakeDeps({ sessionStore: pane })))
    ).resolves.toBe(MCP_SERVER_INSTRUCTIONS);
  });

  it("sends the same instructions regardless of session tier", async () => {
    // Instructions are sent once and have no update notification, so they must
    // not encode a tier that can elevate or decay later in the same session.
    const perTier = await Promise.all(
      (Object.keys(TIER_ALLOWLISTS) as Array<keyof typeof TIER_ALLOWLISTS>).map((tier) =>
        initializeClient(
          createSessionServer(`session-${tier}`, fakeDeps({ sessionStore: fakeSessionStore(tier) }))
        )
      )
    );

    expect(new Set(perTier)).toEqual(new Set([MCP_SERVER_INSTRUCTIONS]));
  });

  it("stays within the authored byte budget", () => {
    // The budget is derived from the client truncation point minus a reserve,
    // and the authorization paragraph is last — overflow silently drops the
    // denial guidance in the field rather than failing anything here.
    expect(Buffer.byteLength(MCP_SERVER_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(
      MCP_SERVER_INSTRUCTIONS_MAX_BYTES
    );
  });

  it("names every tier a session can hold", () => {
    // Adding a tier without describing it here leaves the model unable to
    // reason about a denial it can now receive. Matched with backticks because
    // the bare words `core` and `full` also occur in prose.
    for (const tier of Object.keys(TIER_ALLOWLISTS)) {
      expect(MCP_SERVER_INSTRUCTIONS).toContain(`\`${tier}\``);
    }
    expect(MCP_SERVER_INSTRUCTIONS).toContain(TIER_NOT_PERMITTED_CODE);
  });

  it("names only tools that actually exist", () => {
    // Every dotted id in the text, not a hand-listed subset: a tool rename that
    // skips this prose fails here rather than telling every connecting model to
    // call a name that no longer resolves. New references are covered on
    // arrival, without interpolating constants into model-facing text.
    const referenced = [
      ...MCP_SERVER_INSTRUCTIONS.matchAll(/`([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)`/g),
    ].map(([, id]) => id);

    expect(referenced).toContain(ACTIONS_SEARCH_TOOL_ID);
    expect(referenced).toContain(ACTIONS_GET_SCHEMA_TOOL_ID);
    expect(referenced.filter((id) => !BUILT_IN_ACTION_IDS.includes(id as never))).toEqual([]);
    // Existing as an action is the weaker guard. The instructions go to every
    // session including `external`, whose surface is the hand-curated
    // `mcpExternalTierAllowlist.ts` — `terminal.close` was cut from it in
    // #11592 while staying a perfectly valid BuiltInActionId. Cutting a
    // referenced id without editing the prose would leave the text telling
    // external clients to call something that only ever returns
    // TIER_NOT_PERMITTED.
    expect(referenced.filter((id) => !TIER_ALLOWLISTS.external.has(id))).toEqual([]);
  });
});

describe("sessionServer tools/list handler", () => {
  // The external tier is gated by the curated MCP_TOOL_ALLOWLIST and nothing
  // widens it (#10701, #11537). These manifest-plumbing tests therefore use
  // allowlisted action ids so the live/cache/fail-closed paths are exercised
  // independent of exposure gating.
  function externalDeps(overrides?: Partial<SessionServerDeps>): SessionServerDeps {
    return fakeDeps({
      sessionStore: fakeSessionStore("external"),
      ...overrides,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the live manifest when requestManifest succeeds", async () => {
    const deps = externalDeps({
      requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("actions.list")]),
      getCachedManifest: vi.fn(() => [makeManifestEntry("terminal.list")]),
    });
    const server = createSessionServer("tools-list-fresh", deps);
    await server.connect(makeMockTransport());

    const result = await listTools(server);

    // Fresh result wins over the (different) cache, proving the live path is used.
    expect(result.tools.map((t) => t.name)).toEqual(["actions.list"]);
  });

  /** A route that moves while each listing's fetch is out, per `moves`. */
  function movingRoute(moves: boolean[]) {
    const order: string[] = [];
    const noteToolListRoute = vi.fn(() => {
      order.push("route");
      const moved = moves.shift() ?? false;
      return () => moved;
    });
    return { order, noteToolListRoute };
  }

  it("records the session's route before the listing's fetch (#13350)", async () => {
    const { order, noteToolListRoute } = movingRoute([false]);
    const deps = externalDeps({
      noteToolListRoute,
      requestManifest: vi.fn(async () => {
        order.push("fetch");
        return [makeManifestEntry("actions.list")];
      }),
    });
    const server = createSessionServer("tools-list-route", deps);
    await server.connect(makeMockTransport());

    expect((await listTools(server)).tools.map((t) => t.name)).toEqual(["actions.list"]);
    expect(order).toEqual(["route", "fetch"]);
  });

  it("never serves the answer of a route that moved while the fetch was out (#13350)", async () => {
    // The old route's answer could land after the re-list the move's notice
    // asks for, and the client keeps whichever list came last.
    const { noteToolListRoute } = movingRoute([true, false]);
    const requestManifest = vi
      .fn()
      .mockResolvedValueOnce([makeManifestEntry("terminal.list")])
      .mockResolvedValueOnce([makeManifestEntry("actions.list")]);
    const deps = externalDeps({ noteToolListRoute, requestManifest });
    const server = createSessionServer("tools-list-moved", deps);
    await server.connect(makeMockTransport());

    expect((await listTools(server)).tools.map((t) => t.name)).toEqual(["actions.list"]);
    expect(requestManifest).toHaveBeenCalledTimes(2);
  });

  it("refetches a failed listing once when its route moved, and stops there", async () => {
    const { noteToolListRoute } = movingRoute([true, true]);
    const requestManifest = vi
      .fn()
      .mockRejectedValueOnce(new Error("Manifest request timed out"))
      .mockResolvedValueOnce([makeManifestEntry("actions.list")]);
    const deps = externalDeps({ noteToolListRoute, requestManifest });
    const server = createSessionServer("tools-list-moved-failed", deps);
    await server.connect(makeMockTransport());

    // Still moving after the second fetch: that answer is served, and the
    // route's notice is left to tell the client.
    expect((await listTools(server)).tools.map((t) => t.name)).toEqual(["actions.list"]);
    expect(requestManifest).toHaveBeenCalledTimes(2);
  });

  it("falls back to the cached manifest, warning with the error, when requestManifest rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejection = new Error("Manifest request timed out");
    const deps = externalDeps({
      requestManifest: vi.fn().mockRejectedValue(rejection),
      getCachedManifest: vi.fn(() => [makeManifestEntry("terminal.list")]),
    });
    const server = createSessionServer("tools-list-fallback", deps);
    await server.connect(makeMockTransport());

    const result = await listTools(server);

    expect(result.tools.map((t) => t.name)).toEqual(["terminal.list"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The rejection must reach the log so operators can diagnose the stale serve.
    expect(warnSpy.mock.calls[0]).toContain(rejection);
  });

  it("applies the tier/visibility filter on the cached fallback path", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = externalDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("Manifest request timed out")),
      getCachedManifest: vi.fn(() => [
        makeManifestEntry("actions.list"),
        { ...makeManifestEntry("restricted_tool"), danger: "restricted" as const },
      ]),
    });
    const server = createSessionServer("tools-list-filtered-cache", deps);
    await server.connect(makeMockTransport());

    const result = await listTools(server);

    // shouldExposeTool drops restricted entries even on the cache path.
    expect(result.tools.map((t) => t.name)).toEqual(["actions.list"]);
  });

  it("fails closed with an McpError when requestManifest rejects and no cache exists", async () => {
    const deps = externalDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("MCP renderer bridge unavailable")),
      getCachedManifest: vi.fn(() => null),
    });
    const server = createSessionServer("tools-list-failclosed", deps);
    await server.connect(makeMockTransport());

    await expect(listTools(server)).rejects.toBeInstanceOf(McpError);
    await expect(listTools(server)).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining("Action manifest unavailable"),
    });
  });

  it("fails closed even if the session is unpinned after the await (snapshot before async boundary)", async () => {
    // Pinned session: getCachedManifest returns null while the request is in
    // flight, then teardown flips it to a foreign manifest. The handler must
    // use the pre-await snapshot (null) and fail closed — never serve the
    // foreign cache (#7003 cross-window isolation).
    let firstCall = true;
    const deps = externalDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("MCP renderer bridge destroyed")),
      getCachedManifest: vi.fn(() => {
        if (firstCall) {
          firstCall = false;
          return null;
        }
        return [makeManifestEntry("foreign_tool")];
      }),
    });
    const server = createSessionServer("tools-list-race", deps);
    await server.connect(makeMockTransport());

    await expect(listTools(server)).rejects.toBeInstanceOf(McpError);
    // getCachedManifest was read exactly once — synchronously, before the await.
    expect(deps.getCachedManifest).toHaveBeenCalledTimes(1);
  });

  it("treats an empty cached manifest as a valid zero-tool surface, not unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = externalDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("MCP renderer bridge destroyed")),
      getCachedManifest: vi.fn(() => []),
    });
    const server = createSessionServer("tools-list-empty-cache", deps);
    await server.connect(makeMockTransport());

    const result = await listTools(server);

    expect(result.tools).toEqual([]);
  });
});

// #11525 — discovery must mirror dispatch authority. The renderer builds these
// results with no idea which session called it, so main narrows them on the way
// back out.
describe("sessionServer introspection tier filtering", () => {
  function introspectionDeps(
    tier: "core" | "full" | "external",
    result: unknown,
    overrides?: Partial<SessionServerDeps>
  ) {
    return fakeDeps({
      sessionStore: fakeSessionStore(tier),
      dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result } }),
      ...overrides,
    });
  }

  function entry(id: string, overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
    return { ...makeManifestEntry(id), ...overrides };
  }

  /**
   * The tool result the model actually receives. Read from the text block
   * because `structuredContent` is only built when the manifest lookup
   * resolves an entry carrying an outputSchema, which most of these deps
   * deliberately do not supply.
   */
  function payload<T>(res: { content: unknown }): T {
    return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as T;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops actions.list entries the calling tier cannot dispatch", async () => {
    // `git.push` is on neither tool set; even a full session can never call it,
    // so advertising it in discovery only buys a TIER_NOT_PERMITTED round trip.
    // Give the manifest lookup a real entry with an outputSchema so the
    // handler also emits structuredContent — the two renderings of the result
    // must agree, since they are one filtered value and not two filters.
    const manifestEntry: ActionManifestEntry = {
      ...makeManifestEntry("actions.list"),
      outputSchema: { type: "object", properties: {} },
    };
    const deps = introspectionDeps(
      "full",
      { actions: [entry("actions.list"), entry("git.push"), entry("terminal.list")] },
      { getCachedManifest: vi.fn(() => [manifestEntry]) }
    );
    const server = createSessionServer("s1", deps);
    const res = await callTool(server, { name: "actions.list" });

    const listed = payload<{ actions: ActionManifestEntry[] }>(res).actions.map((a) => a.id);
    expect(listed).toEqual(["actions.list", "terminal.list"]);
    expect(isTierPermitted("full", "git.push")).toBe(false);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toContain("git.push");
    expect(res.structuredContent).toEqual(JSON.parse(text));
  });

  // The same allowlist the call gate reads, projected by origin (#12407): an
  // agent pane's bearer at `full` must not discover unscoped terminal input its
  // dispatch would refuse, while the assistant at that tier still does — and
  // the assistant, which holds the unscoped form, is not offered the owned one.
  it("narrows discovery of unscoped terminal input by origin, not tier", async () => {
    const manifest = {
      actions: [
        entry("terminal.sendCommand"),
        entry("terminal.sendCommandOwned"),
        entry("copyTree.injectToTerminal"),
      ],
    };
    const ids = async (origin: "help" | "external") => {
      const deps = introspectionDeps("full", manifest);
      deps.sessionStore.sessionOriginMap.set("s1", origin);
      const server = createSessionServer("s1", deps);
      const res = await callTool(server, { name: "actions.list" });
      return payload<{ actions: ActionManifestEntry[] }>(res).actions.map((a) => a.id);
    };
    expect(await ids("external")).toEqual(["terminal.sendCommandOwned"]);
    expect(await ids("help")).toEqual(["terminal.sendCommand", "copyTree.injectToTerminal"]);
  });

  it("returns strictly more to a higher tier", async () => {
    // Read through `actions.search`, which both tool sets carry — `actions.list`
    // is itself full-only.
    const matches = {
      totalMatches: 2,
      results: [entry("terminal.list"), entry("project.runCheck")],
    };
    const ids = async (tier: "core" | "full") => {
      const server = createSessionServer("s1", introspectionDeps(tier, matches));
      const res = await callTool(server, {
        name: "actions.search",
        arguments: { query: "run" },
      });
      return payload<{ results: ActionManifestEntry[] }>(res).results.map((a) => a.id);
    };
    expect(await ids("core")).toEqual(["terminal.list"]);
    expect(await ids("full")).toEqual(["terminal.list", "project.runCheck"]);
  });

  it("narrows search to the session's own surface", async () => {
    // Search reports what this tier can dispatch and nothing beyond it: a
    // core session sees terminal.list and not project.runCheck. Post-#11585
    // there is no class of entry that search reaches but tools/list withholds —
    // the tier allowlist is the whole surface, and both gates read it.
    const permittedEntry = entry("terminal.list");
    expect(shouldExposeTool(permittedEntry, "core")).toBe(true);
    expect(isTierPermitted("core", "terminal.list")).toBe(true);
    expect(isTierPermitted("core", "project.runCheck")).toBe(false);

    const deps = introspectionDeps("core", {
      totalMatches: 2,
      results: [permittedEntry, entry("project.runCheck")],
    });
    const server = createSessionServer("s1", deps);
    const res = await callTool(server, {
      name: "actions.search",
      arguments: { query: "terminal" },
    });

    const body = payload<{ totalMatches: number; results: ActionManifestEntry[] }>(res);
    expect(body.results.map((r) => r.id)).toEqual(["terminal.list"]);
    expect(body.totalMatches).toBe(1);
  });

  // #12117. The bug this reproduces: an assistant below the tier an action
  // needs could not see it at any discovery surface, so it told the user
  // Daintree has no such feature. It now learns the name exists and needs
  // `full` — without the name becoming callable anywhere. The bug was filed
  // about `worktree.delete`, which is core for the assistant since #13135; the
  // exemplar is resource teardown, which still sits above a core session.
  describe("first-party existence catalog (#12117)", () => {
    function firstPartyDeps(
      result: unknown,
      overrides?: Partial<SessionServerDeps>
    ): SessionServerDeps {
      const deps = introspectionDeps("core", result, overrides);
      deps.sessionStore.sessionOriginMap.set("s1", "help");
      return deps;
    }

    it("reports a higher-tier action to a renderer-owned session", async () => {
      const deps = firstPartyDeps({
        totalMatches: 2,
        results: [
          entry("terminal.list"),
          entry("worktree.resource.teardown", { category: "worktree" }),
        ],
      });
      const server = createSessionServer("s1", deps);
      const res = await callTool(server, {
        name: "actions.search",
        arguments: { query: "tear down worktree resource" },
      });

      const body = payload<{
        results: ActionManifestEntry[];
        unavailable: Array<{ id: string; minimumTier: string; callable: boolean }>;
      }>(res);
      expect(body.results.map((r) => r.id)).toEqual(["terminal.list"]);
      expect(body.unavailable).toEqual([
        expect.objectContaining({
          id: "worktree.resource.teardown",
          minimumTier: "full",
          callable: false,
        }),
      ]);
    });

    // `actions.list` reaches the filter through its own paged-collection path
    // (`collectListPages`), not the plain dispatch `actions.search` takes, so
    // the catalog has to be proven on both. A snapshot dropped from only the
    // paged path would leave search working and listing silently bare.
    it("reports them through the paged actions.list path too", async () => {
      const deps = firstPartyDeps({
        actions: [
          entry("terminal.list"),
          entry("worktree.resource.teardown", { category: "worktree" }),
        ],
      });
      // `actions.list` is itself full-only, so a core session reaches the paged
      // path only once the user has allowed it that one tool.
      deps.sessionStore.grantCache.issueGrant("s1", "actions.list");
      const server = createSessionServer("s1", deps);
      const res = await callTool(server, { name: "actions.list" });

      const body = payload<{
        actions: ActionManifestEntry[];
        total: number;
        unavailable: Array<{ id: string; minimumTier: string }>;
        unavailableTotal: number;
      }>(res);
      expect(body.actions.map((a) => a.id)).toEqual(["terminal.list"]);
      expect(body.total).toBe(1);
      expect(body.unavailable.map((s) => s.id)).toEqual(["worktree.resource.teardown"]);
      expect(body.unavailableTotal).toBe(1);
    });

    // The catalog and the callable surface are one boundary read twice: the
    // moment a grant admits the id, it must leave the catalog and appear in
    // `actions`. Anything else advertises the same tool in two states at once.
    it("moves a granted id out of the catalog and into the callable list", async () => {
      const deps = firstPartyDeps({ actions: [entry("worktree.resource.teardown")] });
      deps.sessionStore.grantCache.issueGrant("s1", "actions.list");
      const server = createSessionServer("s1", deps);

      const before = payload<{ actions: ActionManifestEntry[]; unavailableTotal: number }>(
        await callTool(server, { name: "actions.list" })
      );
      expect(before.actions).toEqual([]);
      expect(before.unavailableTotal).toBe(1);

      deps.sessionStore.grantCache.issueGrant("s1", "worktree.resource.teardown");

      const after = payload<{
        actions: ActionManifestEntry[];
        unavailable: unknown[];
        unavailableTotal: number;
      }>(await callTool(server, { name: "actions.list" }));
      expect(after.actions.map((a) => a.id)).toEqual(["worktree.resource.teardown"]);
      expect(after.unavailable).toEqual([]);
      expect(after.unavailableTotal).toBe(0);
    });

    // Existence is not dispatchability. The whole #11585 invariant rests on
    // `tools/list` and the callable set being one boundary, and a name in the
    // catalog must not appear on either side of it.
    it("leaves the name out of tools/list and refuses the call", async () => {
      const deps = firstPartyDeps(
        { actions: [entry("worktree.resource.teardown")] },
        {
          requestManifest: vi
            .fn()
            .mockResolvedValue([
              makeManifestEntry("terminal.list"),
              makeManifestEntry("worktree.resource.teardown"),
            ]),
        }
      );
      const server = createSessionServer("s1", deps);

      const listed = await listTools(server);
      expect(listed.tools.map((t) => t.name)).not.toContain("worktree.resource.teardown");

      const denied = await callTool(server, { name: "worktree.resource.teardown", arguments: {} });
      expect(denied.isError).toBe(true);
      expect(toolErrorPayload(denied).code).toBe(TIER_NOT_PERMITTED_CODE);
    });

    it("gives an external-origin session the payload it got before", async () => {
      // Same tier, same manifest — only the origin differs, which is the one
      // fact the catalog gates on.
      const deps = introspectionDeps("core", {
        totalMatches: 2,
        results: [entry("terminal.list"), entry("worktree.delete")],
      });
      deps.sessionStore.sessionOriginMap.set("s1", "external");
      const server = createSessionServer("s1", deps);
      const res = await callTool(server, {
        name: "actions.search",
        arguments: { query: "delete worktree" },
      });

      const body = payload<Record<string, unknown>>(res);
      expect(Object.keys(body).sort()).toEqual(["results", "totalMatches"]);
    });

    it("names the tier on a getSchema read instead of an unknown-id denial", async () => {
      const deps = firstPartyDeps({
        ok: true,
        entry: entry("worktree.resource.teardown", { category: "worktree" }),
        policy: null,
        error: null,
      });
      const server = createSessionServer("s1", deps);
      const res = await callTool(server, {
        name: "actions.getSchema",
        arguments: { actionId: "worktree.resource.teardown" },
      });

      const body = payload<{
        ok: boolean;
        entry: unknown;
        unavailable: { minimumTier: string } | undefined;
        error: { code: string } | null;
      }>(res);
      expect(body.ok).toBe(false);
      expect(body.entry).toBeNull();
      expect(body.error?.code).toBe(TIER_NOT_PERMITTED_CODE);
      expect(body.unavailable?.minimumTier).toBe("full");
    });
  });

  describe("actions.getSchema policy record (#11910)", () => {
    interface GetSchemaBody {
      ok: boolean;
      entry: ActionManifestEntry | null;
      policy: Record<string, unknown> | null;
      error: { code: string; message: string } | null;
    }

    function schemaDeps(
      tier: "core" | "full" | "external",
      target: ActionManifestEntry,
      overrides?: Partial<SessionServerDeps>
    ) {
      // The renderer's real return shape: it fills `entry` and leaves `policy`
      // for main, which is the substitution under test.
      return introspectionDeps(
        tier,
        { ok: true, entry: target, policy: null, error: null },
        overrides
      );
    }

    async function lookup(
      deps: SessionServerDeps,
      actionId: string,
      sessionId = "s1"
    ): Promise<GetSchemaBody> {
      const server = createSessionServer(sessionId, deps);
      const res = await callTool(server, {
        name: ACTIONS_GET_SCHEMA_TOOL_ID,
        arguments: { actionId },
      });
      return payload<GetSchemaBody>(res);
    }

    it("substitutes a real policy for the renderer's null placeholder", async () => {
      const deps = schemaDeps("core", entry("terminal.list"));
      const body = await lookup(deps, "terminal.list");

      // The renderer sent `policy: null`; anything non-null here is main's
      // substitution, which is the wiring under test.
      expect(body.ok).toBe(true);
      expect(body.entry).not.toBeNull();
      expect(body.error).toBeNull();
      expect(body.policy).toMatchObject({ callable: true, authorizedBy: "tier" });
    });

    // The origin is what grant issuance gates on, and a session that never
    // declared one defaults to `external` — so the honest answer for it is that
    // no approval flow exists, whatever tier admitted the call.
    it("reports grantability from the session origin, not its tier", async () => {
      const unowned = schemaDeps("core", entry("terminal.list"));
      expect((await lookup(unowned, "terminal.list")).policy).toMatchObject({
        grantable: false,
      });

      const owned = schemaDeps("core", entry("terminal.list"));
      owned.sessionStore.sessionOriginMap.set("s1", "help");
      expect((await lookup(owned, "terminal.list")).policy).toMatchObject({
        grantable: true,
      });
    });

    it("reports the flat external tier for an api-key caller", async () => {
      const deps = schemaDeps("external", entry("terminal.list"));
      const body = await lookup(deps, "terminal.list");

      // The point of the external branch: `minimumPermittingTier` never returns
      // "external", so a tier derived from it alone would be wrong here.
      expect(body.ok).toBe(true);
      expect(body.policy).toMatchObject({ minimumTier: "external" });
    });

    // A live grant widens discovery, and the record must name the grant as what
    // admits the call — the client's cue that this access can lapse.
    it("names a live per-tool grant as the admitting mechanism", async () => {
      const deps = schemaDeps("core", entry("project.runCheck"));
      deps.sessionStore.sessionOriginMap.set("s1", "help");
      deps.sessionStore.grantCache.issueGrant("s1", "project.runCheck");

      const body = await lookup(deps, "project.runCheck");

      expect(body.ok).toBe(true);
      expect(body.policy).toMatchObject({ authorizedBy: "grant", minimumTier: "full" });
      // The grant is bridging a real gap rather than rubber-stamping a target
      // the tier already allowed — stated as the relation, so it keeps meaning
      // if the fixture's tier changes.
      expect(body.policy?.effectiveTier).not.toBe(body.policy?.minimumTier);
    });

    it("still collapses a tier-denied target with no policy attached", async () => {
      const deps = schemaDeps("core", entry("project.runCheck"));
      const body = await lookup(deps, "project.runCheck");

      expect(body.ok).toBe(false);
      expect(body.entry).toBeNull();
      expect(body.policy).toBeNull();
      expect(body.error?.code).toBe("NOT_FOUND");
    });

    it("never attaches a policy to a hidden or restricted target", async () => {
      for (const overrides of [
        { mcpVisibility: "hidden" as const },
        { danger: "restricted" as const },
      ]) {
        const deps = schemaDeps("core", entry("terminal.list", overrides));
        const body = await lookup(deps, "terminal.list");

        expect(body).toEqual({
          ok: false,
          entry: null,
          policy: null,
          error: { code: "NOT_FOUND", message: expect.stringContaining("terminal.list") },
        });
      }
    });

    // The policy is a snapshot, not a lease. A grant that lapses between two
    // reads must stop admitting the target on the second one — otherwise a
    // client caches an authorization the dispatch gate would already refuse.
    it("stops reporting a grant once its TTL has lapsed", async () => {
      let now = 1000;
      const grantCache = new GrantCache({ ttlMs: 100, sweepIntervalMs: 0, now: () => now });
      const store = fakeSessionStore("core");
      (store as unknown as { grantCache: GrantCache }).grantCache = grantCache;
      store.sessionOriginMap.set("s1", "help");

      const deps = schemaDeps("core", entry("project.runCheck"), { sessionStore: store });
      grantCache.issueGrant("s1", "project.runCheck");

      const whileLive = await lookup(deps, "project.runCheck");
      expect(whileLive.ok).toBe(true);
      expect(whileLive.policy).toMatchObject({ authorizedBy: "grant" });

      now = 50_000;
      const afterExpiry = await lookup(deps, "project.runCheck");
      expect(afterExpiry.ok).toBe(false);
      expect(afterExpiry.policy).toBeNull();

      grantCache.dispose();
    });
  });

  it("over-fetches the search page so denied top hits cannot starve it", async () => {
    // 40 denied hits outrank the permitted ones. A renderer honouring the
    // caller's limit of 3 would return only denied entries, so without the
    // over-fetch the page comes back empty — this dispatcher slices the way
    // the real action does instead of ignoring the limit.
    const ranked = [
      ...Array.from({ length: 40 }, (_, i) => entry(`git.denied${i}`)),
      entry("actions.getSchema"),
      entry("actions.search"),
      entry("terminal.list"),
    ];
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("core"),
      dispatchAction: vi.fn((_id: string, args: unknown) => {
        const limit = (args as { limit?: number }).limit ?? 20;
        return Promise.resolve({
          result: {
            ok: true as const,
            result: { totalMatches: ranked.length, results: ranked.slice(0, limit) },
          },
        });
      }),
    });
    const server = createSessionServer("s1", deps);
    const res = await callTool(server, {
      name: "actions.search",
      arguments: { query: "anything", limit: 3 },
    });

    const body = payload<{ totalMatches: number; results: ActionManifestEntry[] }>(res);
    expect(body.results.map((r) => r.id)).toEqual([
      "actions.getSchema",
      "actions.search",
      "terminal.list",
    ]);
    expect(body.totalMatches).toBe(3);

    // The audit trail must record what the CALLER asked for, not the widened
    // limit main forwarded to the renderer.
    const audited = (deps.appendAuditRecord as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      args: { limit: number };
    };
    expect(audited.args).toEqual({ query: "anything", limit: 3 });
  });

  it("leaves an out-of-contract search limit for the renderer to reject", async () => {
    const deps = introspectionDeps("core", { totalMatches: 0, results: [] });
    const server = createSessionServer("s1", deps);
    await callTool(server, {
      name: "actions.search",
      arguments: { query: "anything", limit: 5000 },
    });

    // The over-fetch must not rewrite an illegal limit into a legal one; the
    // renderer's own validation stays the gate.
    const dispatched = (deps.dispatchAction as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((dispatched[1] as { limit: number }).limit).toBe(5000);
  });

  it("walks every actions.list page before filtering, preserving the caller's filters", async () => {
    // The renderer pages before main can apply the tier filter, so filtering
    // one of its pages would return a short page whose total/hasMore counted
    // actions this session cannot dispatch.
    const permitted = Array.from({ length: 120 }, (_, i) => entry(`actions.p${i}`));
    const all = [...permitted.slice(0, 60), entry("git.push"), ...permitted.slice(60)];
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction: vi.fn((_id: string, callArgs: unknown) => {
        const { offset = 0, limit = 50 } = callArgs as { offset?: number; limit?: number };
        const page = all.slice(offset, offset + limit);
        return Promise.resolve({
          result: {
            ok: true as const,
            result: {
              actions: page,
              total: all.length,
              limit,
              offset,
              hasMore: offset + limit < all.length,
            },
          },
        });
      }),
    });
    const server = createSessionServer("s1", deps);
    await callTool(server, { name: "actions.list", arguments: { category: "git" } });

    const calls = (deps.dispatchAction as ReturnType<typeof vi.fn>).mock.calls;
    // Every page fetched at the maximum window, walking until hasMore clears,
    // and the caller's own filter carried on each request.
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call[1]).toMatchObject({ category: "git", limit: 100 });
    }
    expect(calls.map((c) => (c[1] as { offset: number }).offset)).toEqual([0, 100]);
  });

  it("walks past an empty actions.list page while the view reports more (#13350)", async () => {
    // A Shell answering for a host narrows each page to what a host may run,
    // so the first page can come back empty with a permitted action behind it.
    const pages = [[], [entry("terminal.list")]];
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction: vi.fn((_id: string, callArgs: unknown) => {
        const { offset = 0 } = callArgs as { offset?: number };
        const page = offset / 100;
        return Promise.resolve({
          result: {
            ok: true as const,
            result: { actions: pages[page] ?? [], hasMore: page < pages.length - 1 },
          },
        });
      }),
    });
    const server = createSessionServer("s1", deps);
    const res = await callTool(server, { name: "actions.list" });
    expect(payload<{ actions: ActionManifestEntry[] }>(res).actions.map((a) => a.id)).toEqual([
      "terminal.list",
    ]);
  });

  /**
   * The page walk synthesizes its own envelope instead of returning the
   * renderer's, so the resolved-workspace stamp (#11536) has to be carried
   * across it deliberately. Left out, exactly the calls that span more than one
   * page would omit the field every single-shot dispatch reports — the paged
   * caller would be told less about where its call landed than the unpaged one.
   */
  function pagedListDeps(all: ActionManifestEntry[], dispatchedWorkspace?: DispatchedWorkspaceRef) {
    return fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction: vi.fn((_id: string, callArgs: unknown) => {
        const { offset = 0, limit = 50 } = callArgs as { offset?: number; limit?: number };
        return Promise.resolve({
          result: {
            ok: true as const,
            result: {
              actions: all.slice(offset, offset + limit),
              total: all.length,
              limit,
              offset,
              hasMore: offset + limit < all.length,
            },
          },
          ...(dispatchedWorkspace ? { dispatchedWorkspace } : {}),
        });
      }),
    });
  }

  function workspaceMetaOf(res: unknown): unknown {
    return (res as { _meta?: Record<string, unknown> })._meta?.[RESOLVED_WORKSPACE_META_KEY];
  }

  // A permitted id parked past the first 100-entry window, so a result that
  // contains it proves the walk reached page two.
  const filler = Array.from({ length: 150 }, (_, i) => entry(`git.denied${i}`));
  const spanningTwoPages = [...filler.slice(0, 120), entry("terminal.list"), ...filler.slice(120)];

  it("stamps the resolved workspace on a paged actions.list, as the single-shot path does", async () => {
    const workspace = {
      kind: "project" as const,
      workspaceId: "proj-paged",
      workspacePath: "/repos/paged",
    };
    const deps = pagedListDeps(spanningTwoPages, workspace);
    const server = createSessionServer("s1", deps);

    const res = await callTool(server, { name: "actions.list" });

    // Prove the paged branch really ran, and that page two's content came back.
    expect((deps.dispatchAction as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    expect(payload<{ actions: ActionManifestEntry[] }>(res).actions.map((a) => a.id)).toContain(
      "terminal.list"
    );
    expect(workspaceMetaOf(res)).toEqual(workspace);
  });

  it("omits the workspace key on a paged call whose dispatch resolved none", async () => {
    const deps = pagedListDeps(spanningTwoPages);
    const server = createSessionServer("s1", deps);

    const res = await callTool(server, { name: "actions.list" });

    // Absent, not null — the paged path must not invent a stamp the dispatch
    // never reported, any more than it may drop one it did.
    expect((deps.dispatchAction as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    expect(workspaceMetaOf(res)).toBeUndefined();
  });

  it("pages the permitted set so total and hasMore describe the reachable surface", async () => {
    // Six permitted ids, deliberately split across two renderer pages: three
    // land beyond the first 100-entry window, so a filter applied to a single
    // page would miss them entirely.
    const early = ["actions.search", "actions.getSchema", "terminal.list"];
    const late = ["terminal.getOutput", "terminal.getStatus", "worktree.list"];
    for (const id of [...early, ...late]) {
      expect(isTierPermitted("full", id)).toBe(true);
    }
    const denied = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => entry(`git.denied${from + i}`));
    const all = [
      ...denied(60, 0),
      ...early.map((id) => entry(id)),
      ...denied(37, 60),
      ...late.map((id) => entry(id)),
      ...denied(20, 100),
    ];
    expect(all.length).toBeGreaterThan(100);

    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
      dispatchAction: vi.fn((_id: string, callArgs: unknown) => {
        const { offset = 0, limit = 50 } = callArgs as { offset?: number; limit?: number };
        return Promise.resolve({
          result: {
            ok: true as const,
            result: {
              actions: all.slice(offset, offset + limit),
              total: all.length,
              limit,
              offset,
              hasMore: offset + limit < all.length,
            },
          },
        });
      }),
    });
    const server = createSessionServer("s1", deps);

    const body = payload<{
      actions: ActionManifestEntry[];
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    }>(await callTool(server, { name: "actions.list", arguments: { limit: 4 } }));

    // total counts the permitted surface, not the renderer's raw match count.
    expect(body.total).toBe(6);
    expect(body.actions.map((a) => a.id)).toEqual([...early, "terminal.getOutput"]);
    expect(body.hasMore).toBe(true);

    const second = payload<{ actions: ActionManifestEntry[]; hasMore: boolean }>(
      await callTool(server, { name: "actions.list", arguments: { limit: 4, offset: 4 } })
    );
    // Paging walks the permitted set, so page two continues where page one
    // stopped instead of re-slicing a tier-blind ordering.
    expect(second.actions.map((a) => a.id)).toEqual(["terminal.getStatus", "worktree.list"]);
    expect(second.hasMore).toBe(false);
  });

  it("reports a tier-denied getSchema id as NOT_FOUND rather than advertising it", async () => {
    const deps = introspectionDeps("core", { ok: true, entry: entry("project.runCheck") });
    const server = createSessionServer("s1", deps);
    const res = await callTool(server, {
      name: "actions.getSchema",
      arguments: { actionId: "project.runCheck" },
    });

    const body = payload<{ ok: boolean; error: { code: string } }>(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("leaves non-introspection results untouched", async () => {
    const result = { actions: [entry("git.push")], totalMatches: 99 };
    const deps = introspectionDeps("core", result);
    const server = createSessionServer("s1", deps);
    const res = await callTool(server, { name: "terminal.list" });
    expect(payload(res)).toEqual(result);
  });

  // Read through `actions.search`, the enumerating tool a core session holds:
  // `actions.list` is itself full-only, and the permitted set these widen is
  // computed once for every introspection carrier.
  describe("live grants widen discovery", () => {
    function matches(...ids: string[]) {
      return { totalMatches: ids.length, results: ids.map((id) => entry(id)) };
    }

    async function searchIds(server: ReturnType<typeof createSessionServer>): Promise<string[]> {
      const res = await callTool(server, {
        name: "actions.search",
        arguments: { query: "anything" },
      });
      return payload<{ results: ActionManifestEntry[] }>(res).results.map((a) => a.id);
    }

    it("surfaces a per-tool grant's action in actions.search", async () => {
      const deps = introspectionDeps("core", matches("project.runCheck"));
      const server = createSessionServer("s1", deps);

      expect(await searchIds(server)).toEqual([]);

      deps.sessionStore.grantCache.issueGrant("s1", "project.runCheck");
      expect(await searchIds(server)).toEqual(["project.runCheck"]);

      deps.sessionStore.grantCache.dispose();
    });

    it("surfaces every tool a native automation grant pre-approved", async () => {
      // Native grants (#10648) are issued up front with an explicit allowlist.
      // If discovery ignored them the agent could never find the tools it was
      // just approved for.
      const deps = introspectionDeps(
        "core",
        matches("project.runCheck", "recipe.run", "worktree.delete")
      );
      const server = createSessionServer("s1", deps);
      deps.sessionStore.grantCache.issueNativeGrant({
        sessionId: "s1",
        actorId: "test-actor",
        actorType: "help-session",
        allowedTools: ["project.runCheck", "recipe.run"],
        maxUses: 5,
      });

      expect(await searchIds(server)).toEqual(["project.runCheck", "recipe.run"]);

      deps.sessionStore.grantCache.dispose();
    });

    it("does not surface a per-resolved-target tool a native grant cannot admit (#12121)", async () => {
      // The mirror of the test above. `peekNativeGrant` refuses
      // terminal.closeAll, so listing it here would produce the
      // discoverable-but-uncallable state #11585 rejects: the agent finds the
      // tool, calls it, and is told TIER_NOT_PERMITTED. The eligible sibling
      // proves the grant is otherwise live, so the omission is the policy and
      // not a dead grant.
      const deps = introspectionDeps(
        "core",
        matches("project.runCheck", "terminal.killAll", "terminal.closeAll")
      );
      const server = createSessionServer("s1", deps);
      deps.sessionStore.grantCache.issueNativeGrant({
        sessionId: "s1",
        actorId: "test-actor",
        actorType: "help-session",
        allowedTools: ["project.runCheck", "terminal.killAll", "terminal.closeAll"],
        maxUses: 5,
      });

      expect(await searchIds(server)).toEqual(["project.runCheck"]);

      deps.sessionStore.grantCache.dispose();
    });

    it("does not consume a native grant use or emit lifecycle events while discovering", async () => {
      const emitted: string[] = [];
      const grantCache = new GrantCache({
        sweepIntervalMs: 0,
        emit: (_sessionId, payload) => emitted.push(payload.type),
      });
      const store = fakeSessionStore("core");
      (store as unknown as { grantCache: GrantCache }).grantCache = grantCache;

      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction: vi.fn().mockResolvedValue({
          result: { ok: true, result: matches("project.runCheck") },
        }),
      });
      const server = createSessionServer("s1", deps);
      const grant = grantCache.issueNativeGrant({
        sessionId: "s1",
        actorId: "test-actor",
        actorType: "help-session",
        allowedTools: ["project.runCheck"],
        maxUses: 1,
      });
      emitted.length = 0;

      expect(await searchIds(server)).toEqual(["project.runCheck"]);
      expect(await searchIds(server)).toEqual(["project.runCheck"]);

      // Discovery is a read: the single use is still available for a real call.
      expect(grantCache.getNativeGrant(grant.id)?.remainingUses).toBe(1);
      expect(emitted).toEqual([]);

      grantCache.dispose();
    });

    // Grants are per-session. Reading them unscoped would let session A
    // discover what session B was approved for and then fail to dispatch it —
    // the original bug, recreated across sessions.
    it("ignores grants belonging to a different session", async () => {
      const deps = introspectionDeps(
        "core",
        matches("project.runCheck", "recipe.run", "worktree.delete")
      );
      const server = createSessionServer("s1", deps);
      deps.sessionStore.grantCache.issueGrant("other", "recipe.run");
      deps.sessionStore.grantCache.issueNativeGrant({
        sessionId: "other",
        actorId: "test-actor",
        actorType: "help-session",
        allowedTools: ["worktree.delete"],
        maxUses: 5,
      });
      // One grant that DOES belong to s1, so the test proves scoping rather
      // than merely proving grants were ignored altogether.
      deps.sessionStore.grantCache.issueGrant("s1", "project.runCheck");

      expect(await searchIds(server)).toEqual(["project.runCheck"]);

      deps.sessionStore.grantCache.dispose();
    });

    it("ignores a native grant past its hard lifetime ceiling", async () => {
      let now = 1000;
      const grantCache = new GrantCache({
        ttlMs: 4000,
        maxLifetimeMs: 5000,
        sweepIntervalMs: 0,
        now: () => now,
      });
      const store = fakeSessionStore("core");
      (store as unknown as { grantCache: GrantCache }).grantCache = grantCache;

      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction: vi.fn().mockResolvedValue({
          result: { ok: true, result: matches("project.runCheck") },
        }),
      });
      const server = createSessionServer("s1", deps);
      const grant = grantCache.issueNativeGrant({
        sessionId: "s1",
        actorId: "test-actor",
        actorType: "help-session",
        allowedTools: ["project.runCheck"],
        maxUses: 5,
      });

      // Slide the TTL forward so expiry is still in the future at read time;
      // only the ceiling disqualifies the grant.
      now = 5000;
      grantCache.refreshNativeGrant(grant.id);
      now = 6500;
      expect(grantCache.getActiveNativeGrants("s1")[0]!.expiresAt).toBeGreaterThan(now);

      expect(await searchIds(server)).toEqual([]);

      grantCache.dispose();
    });

    it("ignores a grant that has lapsed its TTL", async () => {
      let now = 1000;
      const grantCache = new GrantCache({ ttlMs: 100, sweepIntervalMs: 0, now: () => now });
      const store = fakeSessionStore("core");
      (store as unknown as { grantCache: GrantCache }).grantCache = grantCache;

      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction: vi.fn().mockResolvedValue({
          result: { ok: true, result: matches("project.runCheck") },
        }),
      });
      const server = createSessionServer("s1", deps);
      grantCache.issueGrant("s1", "project.runCheck");

      now = 50_000;
      expect(await searchIds(server)).toEqual([]);

      grantCache.dispose();
    });
  });

  // A renderer result is not runtime-validated anywhere between the action's
  // `run()` and the MCP wire, so an unexpected shape must deny rather than
  // sail through unfiltered.
  describe("fails closed on a payload shape it does not recognise", () => {
    it("returns no actions when actions is not an array", async () => {
      const deps = introspectionDeps("full", {
        actions: { smuggled: entry("git.push") },
        leaked: [entry("git.push")],
      });
      const server = createSessionServer("s1", deps);
      const res = await callTool(server, { name: "actions.list" });

      expect(payload<{ actions: unknown[] }>(res).actions).toEqual([]);
      // Fields the renderer attached alongside the filtered one are dropped,
      // not forwarded — the payload is rebuilt, never spread.
      expect((res.content as Array<{ text: string }>)[0]!.text).not.toContain("git.push");
    });

    it("returns no search results when results is not an array", async () => {
      const deps = introspectionDeps("core", {
        totalMatches: 99,
        results: "not-an-array",
        leaked: [entry("git.push")],
      });
      const server = createSessionServer("s1", deps);
      const res = await callTool(server, {
        name: "actions.search",
        arguments: { query: "anything" },
      });

      const body = payload<{ totalMatches: number; results: unknown[] }>(res);
      expect(body).toEqual({ totalMatches: 0, results: [] });
      expect((res.content as Array<{ text: string }>)[0]!.text).not.toContain("git.push");
    });

    it("rejects a getSchema answer for an id other than the one requested", async () => {
      // A permitted id must not vouch for a denied entry's schema.
      const deps = introspectionDeps("core", {
        ok: true,
        entry: { ...entry("project.runCheck"), id: "terminal.list" },
      });
      const server = createSessionServer("s1", deps);
      const res = await callTool(server, {
        name: "actions.getSchema",
        arguments: { actionId: "project.runCheck" },
      });

      const body = payload<{ ok: boolean; error: { code: string; message: string } }>(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("NOT_FOUND");
      // The message names what the caller asked for, not what came back.
      expect(body.error.message).toContain("project.runCheck");
    });
  });
});

describe("mcp.surface short-circuit (#11549)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const SURFACE = "mcp.surface";

  function surfaceManifest(): ActionManifestEntry[] {
    return [
      makeManifestEntry("actions.list"),
      makeManifestEntry(SURFACE),
      makeManifestEntry("terminal.list"),
      { ...makeManifestEntry("terminal.new"), kind: "command" as const },
      {
        ...makeManifestEntry("worktree.resource.teardown"),
        kind: "command" as const,
        danger: "confirm" as const,
      },
      { ...makeManifestEntry("actions.persistedStores"), mcpVisibility: "hidden" as const },
    ];
  }

  async function readSurface(
    tier: "core" | "full" | "external",
    overrides?: Partial<SessionServerDeps>
  ) {
    const deps = fakeDeps({
      sessionStore: fakeSessionStore(tier),
      requestManifest: vi.fn().mockResolvedValue(surfaceManifest()),
      ...overrides,
    });
    const server = createSessionServer(`session-surface-${tier}`, deps);
    await server.connect(makeMockTransport());
    const result = await callTool(server, { name: SURFACE });
    return { deps, server, result };
  }

  it("answers from main without dispatching to the renderer", async () => {
    const dispatchAction = vi.fn();
    const { result } = await readSurface("core", { dispatchAction });

    expect(dispatchAction).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      manifestVersion: expect.any(Number),
      appVersion: "0.0.0-test",
      tier: "core",
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  // The one invariant the whole feature rests on: a report that disagreed with
  // the listing would send clients chasing drift that does not exist, or hide
  // drift that does.
  it("reports exactly the tool ids tools/list serves at the same tier", async () => {
    for (const tier of ["core", "full", "external"] as const) {
      const { server, result } = await readSurface(tier);
      const listed = ((await listTools(server)) as { tools: Array<{ name: string }> }).tools
        .map((t) => t.name)
        .sort();
      const reported = (result.structuredContent as { tools: Array<{ id: string }> }).tools.map(
        (t) => t.id
      );

      // Two empty lists compare equal, so pin the listing to something real
      // first — a short-circuit that returned nothing would otherwise pass.
      // `mcp.surface` is the anchor: allowlisted at all three tiers, so its
      // absence means the registration itself regressed.
      expect(listed).toContain(SURFACE);
      expect(listed.length).toBeGreaterThan(1);
      expect(reported).toEqual(listed);
    }
  });

  it("ignores a live grant, so the hash tracks the listing rather than a timer", async () => {
    const sessionStore = fakeSessionStore("core");
    const granted = { ...makeManifestEntry("project.runCheck"), kind: "command" as const };
    const deps = fakeDeps({
      sessionStore,
      requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list"), granted]),
    });
    const server = createSessionServer("session-surface-grant", deps);
    await server.connect(makeMockTransport());

    const before = await callTool(server, { name: SURFACE });
    sessionStore.grantCache.issueGrant("session-surface-grant", "project.runCheck");
    const after = await callTool(server, { name: SURFACE });

    const ids = (r: { structuredContent?: unknown }) =>
      (r.structuredContent as { tools: Array<{ id: string }> }).tools.map((t) => t.id);
    expect(ids(after)).toEqual(ids(before));
    expect(ids(before)).toContain("terminal.list");
    expect(ids(after)).not.toContain("project.runCheck");
    expect((after.structuredContent as { hash: string }).hash).toBe(
      (before.structuredContent as { hash: string }).hash
    );
    sessionStore.grantCache.dispose();
  });

  it("builds against the tier the call was authorized at, not a later re-read", async () => {
    // Authorization has one lifetime per call: a session revoked mid-fetch has
    // no tier at all afterwards (#11799), and re-reading would either refuse a
    // call the gate already admitted or disagree with the audit record that
    // logs the admitted tier. The gate's tier is the only coherent answer.
    // The witness has to be a tool `core` grants and `external` does not, or
    // its absence proves nothing — a tool neither tier reaches is missing
    // either way. Derived rather than named so it cannot rot into a tautology.
    const coreOnly = [...TIER_ALLOWLISTS.core].find((id) => !TIER_ALLOWLISTS.external.has(id));
    expect(coreOnly).toBeDefined();
    const sessionStore = fakeSessionStore("external");
    const deps = fakeDeps({
      sessionStore,
      requestManifest: vi.fn().mockImplementation(async () => {
        vi.mocked(sessionStore.getTier).mockReturnValue(null);
        return [...surfaceManifest(), makeManifestEntry(coreOnly!)];
      }),
    });
    const server = createSessionServer("session-surface-revoked", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: SURFACE });
    const reported = result.structuredContent as {
      tier: string;
      tools: Array<{ id: string }>;
    };

    expect(reported.tier).toBe("external");
    // The concrete tool a core re-read would have added to the report.
    expect(reported.tools.map((t) => t.id)).not.toContain(coreOnly);
    // Resolved once, at the gate — the re-read this guards against would show
    // up here as a second call.
    expect(sessionStore.getTier).toHaveBeenCalledTimes(1);
  });

  it("writes one audit record and settles the activity strip exactly once", async () => {
    const appendAuditRecord = vi.fn();
    const notifyToolCallStarted = vi.fn();
    const notifyToolCallSettled = vi.fn();
    await readSurface("core", {
      appendAuditRecord,
      notifyToolCallStarted,
      notifyToolCallSettled,
    });

    expect(notifyToolCallStarted).toHaveBeenCalledTimes(1);
    expect(notifyToolCallSettled).toHaveBeenCalledTimes(1);
    expect(appendAuditRecord).toHaveBeenCalledTimes(1);
    expect(appendAuditRecord.mock.calls[0]![0]).toMatchObject({
      toolId: SURFACE,
      tier: "core",
      outcome: { kind: "result" },
    });
    // A read never asks the user for anything, so the strip must show a plain
    // in-flight row rather than an awaiting-confirmation one.
    expect(notifyToolCallStarted.mock.calls[0]![0]).toMatchObject({ danger: false });
  });

  it("audits a failed build as a throw rather than a silent success", async () => {
    const appendAuditRecord = vi.fn();
    const deps = fakeDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("renderer gone")),
      getCachedManifest: vi.fn(() => null),
      appendAuditRecord,
    });
    const server = createSessionServer("session-surface-audit-fail", deps);
    await server.connect(makeMockTransport());

    await expect(callTool(server, { name: SURFACE })).rejects.toThrow();

    expect(appendAuditRecord).toHaveBeenCalledTimes(1);
    expect(appendAuditRecord.mock.calls[0]![0]).toMatchObject({
      toolId: SURFACE,
      outcome: { kind: "throw" },
    });
  });

  it("falls back to the cached manifest when the live fetch fails", async () => {
    const deps = fakeDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("renderer gone")),
      getCachedManifest: vi.fn(() => surfaceManifest()),
    });
    const server = createSessionServer("session-surface-cached", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: SURFACE });

    expect(result.isError).not.toBe(true);
    expect(
      (result.structuredContent as { tools: Array<{ id: string }> }).tools.length
    ).toBeGreaterThan(0);
  });

  it("fails closed for a pinned session whose renderer is gone", async () => {
    // getCachedManifest returns null for pinned sessions (#7003), so there is no
    // safe fallback — serving another window's surface would be worse than an error.
    const deps = fakeDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("renderer gone")),
      getCachedManifest: vi.fn(() => null),
    });
    const server = createSessionServer("session-surface-pinned", deps);
    await server.connect(makeMockTransport());

    await expect(callTool(server, { name: SURFACE })).rejects.toThrow(/manifest unavailable/i);
  });
});
