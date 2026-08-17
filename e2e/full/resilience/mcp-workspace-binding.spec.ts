/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC payloads and window globals are untyped */
import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import {
  launchApp,
  closeApp,
  openSecondWindow,
  getWindowPage,
  focusWindow,
  closeWindow,
  type AppContext,
} from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { T_LONG } from "../../helpers/timeouts";
import path from "path";

/**
 * End-to-end probe for workspace-bound external MCP sessions (#11788 / #11789 /
 * #11790), driven over the real Streamable HTTP endpoint with two windows and
 * two live API-key sessions.
 *
 * The unit suites cover the routing decision. What only a two-window E2E can
 * show is that the decision survives real focus changes, a real renderer
 * teardown, and that binding a background workspace leaves the visible app
 * untouched — the criteria #11788 asks for that no existing spec exercises.
 */

const PROTOCOL_VERSION = "2025-06-18";
const WORKSPACE_HEADER = "Daintree-Workspace-Id";
const RESOLVED_WORKSPACE_META = "org.daintree/resolved-workspace";
const BINDING_CAPABILITY = "org.daintree/workspace-binding";

interface McpEndpoint {
  port: number;
  apiKey: string;
}

interface JsonRpcResponse {
  status: number;
  sessionId: string | null;
  body: any;
}

/** Parse a Streamable HTTP reply — SSE by default, JSON when the server folds it. */
function parseBody(contentType: string, raw: string): any {
  if (!raw) return null;
  if (contentType.includes("text/event-stream")) {
    const payloads = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (payloads.length === 0) return null;
    return JSON.parse(payloads[payloads.length - 1]);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function post(
  endpoint: McpEndpoint,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  query = ""
): Promise<JsonRpcResponse> {
  // A deadline of its own, so a call that never comes back fails as itself
  // rather than as an orphaned request outliving the test that made it.
  // Deliberately looser than the poll deadlines wrapping some of these: when a
  // stall could trip either timer, the poll timeout names the assertion that
  // was waiting, so it is the one that should fire first.
  const res = await fetch(`http://127.0.0.1:${endpoint.port}/mcp${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${endpoint.apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(T_LONG * 2),
  });
  const raw = await res.text();
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    body: parseBody(res.headers.get("content-type") ?? "", raw),
  };
}

/**
 * Full handshake. `workspaceId` binds the session; omit it for the legacy
 * focus-following session the binding work deliberately preserves.
 */
async function initializeSession(
  endpoint: McpEndpoint,
  options: { workspaceId?: string; clientName?: string; query?: string } = {}
): Promise<{ sessionId: string; init: JsonRpcResponse }> {
  const headers: Record<string, string> = {};
  if (options.workspaceId) headers[WORKSPACE_HEADER] = options.workspaceId;

  const init = await post(
    endpoint,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: options.clientName ?? "binding-probe", version: "1.0.0" },
      },
    },
    headers,
    options.query ?? ""
  );

  if (!init.sessionId) {
    throw new Error(
      `initialize did not return a session id (status ${init.status}): ${JSON.stringify(init.body)}`
    );
  }

  await post(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "mcp-session-id": init.sessionId, "mcp-protocol-version": PROTOCOL_VERSION }
  );

  return { sessionId: init.sessionId, init };
}

let nextRequestId = 100;

async function callTool(
  endpoint: McpEndpoint,
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<any> {
  const res = await post(
    endpoint,
    {
      jsonrpc: "2.0",
      id: nextRequestId++,
      method: "tools/call",
      params: { name, arguments: args },
    },
    { "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION }
  );
  return res.body;
}

async function listTools(endpoint: McpEndpoint, sessionId: string): Promise<any> {
  const res = await post(
    endpoint,
    { jsonrpc: "2.0", id: nextRequestId++, method: "tools/list", params: {} },
    { "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION }
  );
  return res.body;
}

/** The workspace a call actually landed in, per the server's own `_meta` stamp. */
function resolvedWorkspaceId(toolResponse: any): string | null {
  return toolResponse?.result?._meta?.[RESOLVED_WORKSPACE_META]?.workspaceId ?? null;
}

/** One workspace's two identities: its id, and the fixture basename its paths carry. */
interface WorkspaceIdentity {
  workspaceId: string;
  basename: string;
}

/**
 * Reads the workspace a call actually landed in out of the payload itself
 * rather than the server's own label — `actions.getContext` names its project,
 * and every path in `worktree.list` sits under one project's fixture directory.
 * Returns null for identity-free payloads (`terminal.list` on an idle project).
 *
 * Built as a factory taking its identities explicitly: closing over the suite's
 * module-scoped fixture state would make the helper silently dependent on
 * `describe.serial` ordering, and it would break the day someone extracts it to
 * a shared helper file.
 */
function makePayloadWorkspaceReader(identities: readonly WorkspaceIdentity[]) {
  return function payloadWorkspaceId(toolResponse: any): string | null {
    const text = toolResponse?.result?.content?.[0]?.text;
    if (typeof text !== "string") return null;

    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.projectId === "string") return parsed.projectId;
    } catch {
      // Not JSON — fall through to the path match below.
    }

    // Exactly one fixture may match. Fixture basenames carry a random suffix, so
    // an ambiguous hit means the payload spans workspaces — report "unknown"
    // rather than guessing, which would silently weaken every caller.
    const hits = identities.filter((identity) => text.includes(identity.basename));
    return hits.length === 1 ? hits[0].workspaceId : null;
  };
}

/** The BrowserWindow the OS currently considers focused, or null. */
async function focusedWindowId(app: ElectronApplication): Promise<number | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getFocusedWindow();
    return win && !win.isDestroyed() ? win.id : null;
  });
}

/**
 * Everything the user can see that a background-routed call must not disturb:
 * which window has OS focus, which project each window has attached, and which
 * worktree row each project view marks active.
 */
async function captureVisibleState(
  app: ElectronApplication,
  pages: Record<string, Page>
): Promise<Record<string, unknown>> {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const focused = BrowserWindow.getFocusedWindow();
    return {
      focusedWindowId: focused && !focused.isDestroyed() ? focused.id : null,
      windowIds: BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed())
        .map((w) => w.id)
        .sort((a, b) => a - b),
    };
  });

  const perPage: Record<string, unknown> = {};
  for (const [label, page] of Object.entries(pages)) {
    perPage[label] = await page.evaluate(() => ({
      projectId: (window as any).__DAINTREE_INITIAL_PROJECT__?.id ?? null,
      activeWorktree:
        document
          .querySelector('[data-worktree-row][aria-current="true"]')
          ?.getAttribute("data-worktree-row") ?? null,
    }));
  }

  return { ...main, ...perPage };
}

let ctx: AppContext;
let pageA: Page;
let pageB: Page;
let windowIdA: number;
let windowIdB: number;
let workspaceA: string;
let workspaceB: string;
let basenameA: string;
let basenameB: string;
let repoC: string;
let endpoint: McpEndpoint;
let fixtureCleanups: Array<() => void> = [];
/** Bound once the fixtures and workspace ids are known — see beforeAll. */
let payloadWorkspaceId: (toolResponse: any) => string | null;

test.describe.serial("MCP: external sessions bound to a workspace (#11788)", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const fixtures = createFixtureRepos(3);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    const [repoA, repoB, thirdRepo] = fixtures.map((f) => f.dir);
    repoC = thirdRepo;
    basenameA = path.basename(repoA);
    basenameB = path.basename(repoB);

    ctx = await launchApp();
    pageA = await openAndOnboardProject(ctx.app, ctx.window, repoA, "mcp-bind-A");
    ctx.window = pageA;
    windowIdA = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);

    const handle = await openSecondWindow(ctx.app, pageA, { projectPath: repoB });
    windowIdB = handle.windowId;
    pageB = await getWindowPage(ctx.app, windowIdB);

    const readWorkspaceId = (page: Page) =>
      page.evaluate(() => (window as any).__DAINTREE_INITIAL_PROJECT__?.id ?? null);

    await expect
      .poll(async () => (await readWorkspaceId(pageA)) && (await readWorkspaceId(pageB)), {
        timeout: T_LONG,
        intervals: [200, 400, 800],
      })
      .toBeTruthy();

    workspaceA = (await readWorkspaceId(pageA))!;
    workspaceB = (await readWorkspaceId(pageB))!;
    payloadWorkspaceId = makePayloadWorkspaceReader([
      { workspaceId: workspaceA, basename: basenameA },
      { workspaceId: workspaceB, basename: basenameB },
    ]);
    expect(workspaceA).not.toBe(workspaceB);

    const status = await pageA.evaluate(() => (window as any).electron.mcpServer.setEnabled(true));
    await expect
      .poll(
        async () => {
          const s = await pageA.evaluate(() => (window as any).electron.mcpServer.getStatus());
          return s.port;
        },
        { timeout: T_LONG, intervals: [200, 400, 800] }
      )
      .toBeTruthy();

    const ready = await pageA.evaluate(() => (window as any).electron.mcpServer.getStatus());
    // `||`, not `??`: getStatus reports `this.apiKey ?? ""`, so a server that
    // hasn't minted its key yet returns an empty string rather than a nullish
    // value. Nullish-coalescing would carry that through and every request
    // would send a bare `Bearer `, surfacing as an opaque 401 at the handshake.
    const apiKey = ready.apiKey || status?.apiKey;
    expect(apiKey, "MCP server reported no API key after being enabled").toBeTruthy();
    endpoint = { port: ready.port, apiKey };
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });
  test("bound sessions stay on their own workspace while focus moves", async () => {
    const a = await initializeSession(endpoint, { workspaceId: workspaceA, clientName: "agent-A" });
    const b = await initializeSession(endpoint, { workspaceId: workspaceB, clientName: "agent-B" });

    // The binding is advertised up front, before any mutation can be issued.
    const bindingA = a.init.body?.result?.capabilities?.experimental?.[BINDING_CAPABILITY];
    const bindingB = b.init.body?.result?.capabilities?.experimental?.[BINDING_CAPABILITY];
    expect(bindingA?.workspaceId).toBe(workspaceA);
    expect(bindingB?.workspaceId).toBe(workspaceB);

    // An unbound session runs alongside so the bound pair is exercised under
    // concurrent focus-following traffic rather than in isolation — the shape a
    // real multi-agent setup has. Its own correctness is asserted separately, by
    // the focus-following test, which owns its trace end to end.
    const canary = await initializeSession(endpoint, { clientName: "legacy-unbound" });
    expect(
      canary.init.body?.result?.capabilities?.experimental?.[BINDING_CAPABILITY]
    ).toBeUndefined();

    const observed: Array<{
      session: string;
      tool: string;
      focused: number | null;
      landedIn: string | null;
    }> = [];

    const focusSweep = [windowIdB, windowIdA, windowIdB, windowIdA];
    const tools = ["actions.getContext", "terminal.list", "worktree.list"];
    const sessions = [
      ["A", a.sessionId],
      ["B", b.sessionId],
      ["canary", canary.sessionId],
    ] as const;
    // `terminal.list` is the one identity-free payload (both projects are idle),
    // so it is the only tool that contributes no landing evidence.
    const identityBearingTools = tools.length - 1;

    for (const focusTarget of focusSweep) {
      await focusWindow(ctx.app, focusTarget, focusTarget === windowIdA ? pageA : pageB);
      const focused = await focusedWindowId(ctx.app);
      for (const tool of tools) {
        for (const [session, sessionId] of sessions) {
          const response = await callTool(endpoint, sessionId, tool);
          observed.push({ session, tool, focused, landedIn: payloadWorkspaceId(response) });
        }
      }
    }

    console.log(
      "[probe] interleave",
      JSON.stringify({ workspaceA, workspaceB, windowIdA, windowIdB, observed }, null, 2)
    );

    // Ground truth is the payload each call came back with, not the server's own
    // `_meta` label — a mislabelled-but-correctly-routed call still has to fail
    // this, and a correctly-labelled-but-misrouted one has to fail it too.
    const strayA = observed.filter(
      (o) => o.session === "A" && o.landedIn !== null && o.landedIn !== workspaceA
    );
    const strayB = observed.filter(
      (o) => o.session === "B" && o.landedIn !== null && o.landedIn !== workspaceB
    );
    expect(
      { strayA, strayB },
      `bound calls leaked across workspaces: ${JSON.stringify(observed, null, 2)}`
    ).toEqual({ strayA: [], strayB: [] });

    // The premise this run rests on: OS focus really did move between the two
    // windows. (Whether the app's routing followed it is the canary's business,
    // asserted separately so a routing regression doesn't mask this result.)
    const focusStates = new Set(observed.map((o) => o.focused));
    expect(
      [...focusStates].sort(),
      "focus never moved between windows, so this run never exercised a focus change"
    ).toEqual([windowIdA, windowIdB].sort());

    // Guards against the loop silently shrinking (a dropped tool or session
    // would otherwise leave the stray-filters trivially empty). Derived from the
    // loop inputs rather than hardcoded, so adding a tool doesn't mean editing a
    // magic number.
    expect(observed.length).toBe(focusSweep.length * tools.length * sessions.length);
    expect(observed.filter((o) => o.landedIn !== null).length).toBe(
      focusSweep.length * identityBearingTools * sessions.length
    );
  });

  test("driving a background workspace changes nothing the user can see", async () => {
    // Focus A, then drive B — the background one — hard.
    await focusWindow(ctx.app, windowIdA, pageA);
    const before = await captureVisibleState(ctx.app, { pageA, pageB });

    const b = await initializeSession(endpoint, { workspaceId: workspaceB, clientName: "bg-B" });
    const rounds = 5;
    const tools = ["actions.getContext", "worktree.list", "terminal.list"];
    const landings: Array<{ tool: string; landedIn: string | null }> = [];
    for (let i = 0; i < rounds; i++) {
      for (const tool of tools) {
        const landedIn = payloadWorkspaceId(await callTool(endpoint, b.sessionId, tool));
        expect(landedIn === null || landedIn === workspaceB).toBe(true);
        landings.push({ tool, landedIn });
      }
    }
    // Without this, a run where every call errored out would land `null` across
    // the board and sail through the assertion above having proved nothing.
    // Per tool rather than a total: a tool that stopped reporting identity is
    // caught either way, but one transient error no longer fails the run.
    // `terminal.list` is excluded because its payload carries no identity at all
    // while both projects are idle, which is the expected state here.
    for (const tool of tools.filter((t) => t !== "terminal.list")) {
      expect(
        landings.filter((l) => l.tool === tool && l.landedIn !== null).length,
        `${tool} never reported a workspace id in ${rounds} rounds`
      ).toBeGreaterThan(0);
    }

    const after = await captureVisibleState(ctx.app, { pageA, pageB });
    expect(after).toEqual(before);
  });

  test("confirm-gated tools are withheld from a bound session", async () => {
    const bound = await initializeSession(endpoint, {
      workspaceId: workspaceA,
      clientName: "confirm-probe-bound",
    });
    const unbound = await initializeSession(endpoint, { clientName: "confirm-probe-unbound" });

    const names = (listed: any): string[] =>
      (listed?.result?.tools ?? []).map((t: { name: string }) => t.name);

    const boundTools = names(await listTools(endpoint, bound.sessionId));
    const unboundTools = names(await listTools(endpoint, unbound.sessionId));

    expect(boundTools.length).toBeGreaterThan(0);
    expect(unboundTools).toContain("recipe.run");
    expect(boundTools).not.toContain("recipe.run");

    // And a direct call is refused before dispatch, not left rendering a dialog
    // into a view nobody is looking at.
    const direct = await callTool(endpoint, bound.sessionId, "recipe.run", { recipeId: "nope" });
    const payload = JSON.stringify(direct);
    expect(payload).toContain("CONFIRMATION_REQUIRED");
    expect(payload).toContain("workspace-bound");
  });

  test("handshake refuses an unknown or ambiguous workspace without creating a session", async () => {
    const unknown = await post(
      endpoint,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "unknown-workspace", version: "1.0.0" },
        },
      },
      { [WORKSPACE_HEADER]: "workspace-that-does-not-exist" }
    );

    expect(unknown.status).toBe(400);
    expect(unknown.sessionId).toBeNull();
    expect(JSON.stringify(unknown.body)).toContain("WORKSPACE_NOT_FOUND");

    // Header and query param disagreeing is fatal rather than silently resolved.
    const mismatch = await post(
      endpoint,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "mismatched-selector", version: "1.0.0" },
        },
      },
      { [WORKSPACE_HEADER]: workspaceA },
      `?workspaceId=${encodeURIComponent(workspaceB)}`
    );

    expect(mismatch.status).toBe(400);
    expect(mismatch.sessionId).toBeNull();
    expect(JSON.stringify(mismatch.body)).toContain("WORKSPACE_SELECTOR_MISMATCH");
  });

  test("an unbound session follows focus (documented legacy behaviour)", async () => {
    // #11564 made an unbound session route by focus order rather than
    // registration order. Asserted per observation, not as a set: a session that
    // merely visited both workspaces in some order — or tracked something other
    // than focus — has to fail this, which a "both ids appeared" check would
    // have passed.
    const unbound = await initializeSession(endpoint, { clientName: "follows-focus" });
    const expected = new Map([
      [windowIdA, workspaceA],
      [windowIdB, workspaceB],
    ]);

    const trace: Array<{ focused: number | null; landedIn: string | null; wanted: string }> = [];
    for (const target of [windowIdB, windowIdA, windowIdB, windowIdA]) {
      await focusWindow(ctx.app, target, target === windowIdA ? pageA : pageB);
      const focused = await focusedWindowId(ctx.app);
      const landedIn = payloadWorkspaceId(
        await callTool(endpoint, unbound.sessionId, "actions.getContext")
      );
      trace.push({ focused, landedIn, wanted: expected.get(focused ?? -1) ?? "unknown-window" });
    }

    // Premise: OS focus really did alternate. Without this the correlation below
    // could hold trivially by nothing ever moving.
    expect([...new Set(trace.map((t) => t.focused))].sort()).toEqual([windowIdA, windowIdB].sort());
    expect(trace.map((t) => t.landedIn)).toEqual(trace.map((t) => t.wanted));
  });

  test("every bound result carries the resolved-workspace stamp", async () => {
    const a = await initializeSession(endpoint, { workspaceId: workspaceA, clientName: "stamp-A" });
    const b = await initializeSession(endpoint, { workspaceId: workspaceB, clientName: "stamp-B" });

    const stamps = {
      A: resolvedWorkspaceId(await callTool(endpoint, a.sessionId, "actions.getContext")),
      B: resolvedWorkspaceId(await callTool(endpoint, b.sessionId, "actions.getContext")),
    };
    const bindings = {
      A: a.init.body?.result?.capabilities?.experimental?.[BINDING_CAPABILITY],
      B: b.init.body?.result?.capabilities?.experimental?.[BINDING_CAPABILITY],
    };

    console.log("[probe] stamps", JSON.stringify({ workspaceA, workspaceB, stamps, bindings }));

    expect(stamps).toEqual({ A: workspaceA, B: workspaceB });
  });

  test("the stamp does not depend on which window was created last", async () => {
    // Discriminator for the missing-stamp finding. If the stamp resolves through
    // per-window state, opening a third window changes nothing for A and B. If it
    // resolves through a process-global that the newest window overwrites, the
    // set of stamped workspaces follows window creation order instead.
    const before = {
      A: resolvedWorkspaceId(
        await callTool(
          endpoint,
          (await initializeSession(endpoint, { workspaceId: workspaceA, clientName: "ord-A1" }))
            .sessionId,
          "actions.getContext"
        )
      ),
      B: resolvedWorkspaceId(
        await callTool(
          endpoint,
          (await initializeSession(endpoint, { workspaceId: workspaceB, clientName: "ord-B1" }))
            .sessionId,
          "actions.getContext"
        )
      ),
    };

    const handleC = await openSecondWindow(ctx.app, pageA, { projectPath: repoC });
    try {
      const pageC = await getWindowPage(ctx.app, handleC.windowId);
      const workspaceC = await pageC.evaluate(
        () => (window as any).__DAINTREE_INITIAL_PROJECT__?.id ?? null
      );
      // A null id would silently omit the binding header below, turning the
      // bound case into an unbound one that passes for the wrong reason.
      expect(workspaceC, "third window never reported a workspace id").not.toBeNull();

      const after = {
        A: resolvedWorkspaceId(
          await callTool(
            endpoint,
            (await initializeSession(endpoint, { workspaceId: workspaceA, clientName: "ord-A2" }))
              .sessionId,
            "actions.getContext"
          )
        ),
        B: resolvedWorkspaceId(
          await callTool(
            endpoint,
            (await initializeSession(endpoint, { workspaceId: workspaceB, clientName: "ord-B2" }))
              .sessionId,
            "actions.getContext"
          )
        ),
        C: resolvedWorkspaceId(
          await callTool(
            endpoint,
            (await initializeSession(endpoint, { workspaceId: workspaceC, clientName: "ord-C" }))
              .sessionId,
            "actions.getContext"
          )
        ),
      };

      console.log(
        "[probe] stamp-vs-window-order",
        JSON.stringify({ workspaceA, workspaceB, workspaceC, before, after }, null, 2)
      );

      expect(after).toEqual({ A: workspaceA, B: workspaceB, C: workspaceC });
      expect(before).toEqual({ A: workspaceA, B: workspaceB });
    } finally {
      // Window C must not outlive this test even when an assertion above throws —
      // the teardown test that follows counts on A and B being the only windows.
      await closeWindow(ctx.app, handleC.windowId).catch(() => {});
      await focusWindow(ctx.app, windowIdA, pageA);
    }
  });

  test("losing the bound view fails that session closed and leaves the other running", async () => {
    const a = await initializeSession(endpoint, {
      workspaceId: workspaceA,
      clientName: "survivor-A",
    });
    const b = await initializeSession(endpoint, {
      workspaceId: workspaceB,
      clientName: "doomed-B",
    });

    expect(payloadWorkspaceId(await callTool(endpoint, b.sessionId, "actions.getContext"))).toBe(
      workspaceB
    );

    await focusWindow(ctx.app, windowIdA, pageA);
    await closeWindow(ctx.app, windowIdB);

    // Polled: the binding resolves against live views, and the renderer teardown
    // that follows `closeWindow` is not instantaneous, so a single synchronous
    // call here could read the pre-teardown state on a slow machine.
    let afterClose: any;
    await expect
      .poll(
        async () => {
          afterClose = await callTool(endpoint, b.sessionId, "actions.getContext");
          return JSON.stringify(afterClose);
        },
        { timeout: T_LONG, intervals: [200, 400, 800] }
      )
      .toMatch(/SESSION_BINDING_GONE|No live Daintree view is open/);

    // The whole point: it fails, and it does NOT quietly answer with A's state.
    expect(payloadWorkspaceId(afterClose)).not.toBe(workspaceA);

    // Window B is gone, so window A holds the only live project view and an
    // unbound session has exactly one place it can go. Reaching A proves focus
    // routing can see a view opened into an existing window; failing here means
    // it cannot, which is the shape of the bug this PR fixes.
    const orphan = await initializeSession(endpoint, { clientName: "unbound-after-close" });
    const orphanResponse = await callTool(endpoint, orphan.sessionId, "actions.getContext");
    expect(
      payloadWorkspaceId(orphanResponse),
      `an unbound session could not reach the only remaining window: ${JSON.stringify(
        orphanResponse
      ).slice(0, 400)}`
    ).toBe(workspaceA);

    // A is untouched by B's collapse.
    expect(payloadWorkspaceId(await callTool(endpoint, a.sessionId, "actions.getContext"))).toBe(
      workspaceA
    );
  });
});
