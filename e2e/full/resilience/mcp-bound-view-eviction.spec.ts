import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../../helpers/workflows";
import { T_LONG } from "../../helpers/timeouts";

/**
 * #11790 moved a cached view backing a live MCP session binding into the LAST
 * eviction tier (`boundMcpSession` in `ProjectViewEvictionController`), and
 * shipped with no end-to-end coverage — the existing LRU spec has no MCP
 * session to bind, and `mcp-workspace-binding.spec.ts` cannot host this because
 * it is built around two windows and this needs three projects in one.
 *
 * The observable is membership of the view map after an eviction pass: a real
 * renderer teardown, not a heuristic reading, which is why this half of #11790
 * is coverable from Playwright where the freeze half (#11846) is not.
 *
 * A within-run A/B on one app instance, three projects, one window, arranged
 * into the same LRU order both times:
 *
 *   CONTROL — nothing bound: A is the oldest cached view, so A dies. This is
 *             exactly the pre-#11790 behaviour.
 *   BOUND   — a real HTTP session bound to A: A is STILL the oldest, but the
 *             younger view B dies and A survives. LRU inverted.
 *
 * Only the guard can produce the second outcome, which is what makes the pair
 * discriminating rather than merely green: neutering the tier assignment to
 * `false && (mcp.liveBinding || mcp.unknown)` fails BOUND at its identity
 * assertion while CONTROL keeps passing.
 *
 * The binding is established over the real Streamable HTTP endpoint. No tool
 * call is needed — `hasLiveWorkspaceBinding` only requires an external session
 * present in the store, so the `initialize` handshake alone flips `liveBinding`
 * for a workspace whose view is cached rather than active.
 */

const PROTOCOL_VERSION = "2025-06-18";
const WORKSPACE_HEADER = "Daintree-Workspace-Id";
const BINDING_CAPABILITY = "org.daintree/workspace-binding";

// Project name stems — matched against the `daintree-e2e-<stem>-XXXX` directory
// basename by the palette, so these are fixed by `createFixtureRepos`, not free
// labels (see `waitForActiveProject` + the palette's `hasText` filter).
const PROJECT_A = "project-A";
const PROJECT_B = "project-B";
const PROJECT_C = "project-C";

/** Three cached views, then one, so exactly one eviction decision is observed. */
const CACHE_LIMIT_ARRANGED = 3;
const CACHE_LIMIT_TRIGGER = 2;

interface McpEndpoint {
  port: number;
  apiKey: string;
}

/** Parse a Streamable HTTP reply — SSE by default, JSON when the server folds it. */
function parseBody(contentType: string, raw: string): unknown {
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
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; sessionId: string | null; body: unknown }> {
  // A deadline of its own so a call that never returns fails as itself rather
  // than as an orphaned request outliving the test that made it.
  const res = await fetch(`http://127.0.0.1:${endpoint.port}/mcp`, {
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

/** The workspace the server says it bound the session to, per the handshake. */
function advertisedBinding(initBody: unknown): string | null {
  const experimental = (
    initBody as {
      result?: { capabilities?: { experimental?: Record<string, { workspaceId?: string }> } };
    } | null
  )?.result?.capabilities?.experimental;
  return experimental?.[BINDING_CAPABILITY]?.workspaceId ?? null;
}

async function initializeSession(
  endpoint: McpEndpoint,
  options: { workspaceId?: string; clientName?: string } = {}
): Promise<{ sessionId: string; boundTo: string | null }> {
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
        clientInfo: { name: options.clientName ?? "evict-probe", version: "1.0.0" },
      },
    },
    headers
  );
  if (!init.sessionId) {
    throw new Error(
      `initialize did not return a session id (status ${init.status}): ` +
        `${JSON.stringify(init.body).slice(0, 400)}`
    );
  }

  await post(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "mcp-session-id": init.sessionId, "mcp-protocol-version": PROTOCOL_VERSION }
  );

  return { sessionId: init.sessionId, boundTo: advertisedBinding(init.body) };
}

interface PvmViewProbe {
  projectId: string;
  state: string;
  lastUsed: number;
  liveBinding: boolean;
  dispatchLease: boolean;
  /** The activity callback threw — deprioritizes like a binding, so it is a premise. */
  unknown: boolean;
}

interface PvmProbe {
  ok: boolean;
  activeProjectId: string | null;
  /**
   * The view still bridging a switch. `evictStaleViews` excludes it, so an
   * arrangement that triggers while it is set can evict something other than
   * the LRU-oldest candidate — a false result either direction.
   */
  outgoingBridgeProjectId: string | null;
  views: PvmViewProbe[];
}

type ProbedPvm = {
  getActiveProjectId: () => string | null;
  getOutgoingBridgeProjectId: () => string | null;
  getAllViews: () => Array<{
    projectId: string;
    state: string;
    lastUsed: number;
    view: { webContents: Electron.WebContents };
  }>;
  mcpActivityFor: (
    workspaceId: string,
    wc: Electron.WebContents
  ) => { liveBinding: boolean; dispatchLease: boolean; unknown: boolean };
};

async function readPvmState(app: AppContext["app"]): Promise<PvmProbe> {
  return app.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    const getPvm = g.__daintreeGetPvm as (() => unknown) | undefined;
    const pvm = getPvm?.() as ProbedPvm | null | undefined;
    if (!pvm) return { ok: false, activeProjectId: null, outgoingBridgeProjectId: null, views: [] };
    return {
      ok: true,
      activeProjectId: pvm.getActiveProjectId(),
      outgoingBridgeProjectId: pvm.getOutgoingBridgeProjectId(),
      views: pvm.getAllViews().map((entry) => {
        const mcp = pvm.mcpActivityFor(entry.projectId, entry.view.webContents);
        return {
          projectId: entry.projectId,
          state: entry.state,
          lastUsed: entry.lastUsed,
          liveBinding: mcp.liveBinding,
          dispatchLease: mcp.dispatchLease,
          unknown: mcp.unknown,
        };
      }),
    };
  });
}

interface PvmConfigureResult {
  /** Read back inside the same synchronous block that nulled it. */
  lowMemoryFloorMb: number | null;
  forcedReclaimStubbed: boolean;
}

/**
 * Arm the PVM and trigger the eviction pass, in one synchronous main-process
 * block so nothing can land between the two. Both measures below are test
 * isolation around the seam, not substitutes for it: the tier assignment under
 * test still runs unmodified, against real views and a real MCP session.
 *
 * 1. `setLowMemoryFreeThresholdMb(null)` closes the periodic sampler's pressure
 *    path (a null policy makes `level` "none", so `gradualPressure` can never
 *    be true) but NOT the forced tier-2 reclaim, which is plain `forcePressure`
 *    and never consults the policy — a forced pass sets `effectiveMax = 1` with
 *    an infinite budget and would collapse the cache to the active view,
 *    evicting A and inverting the BOUND assertion. `reclaimCachedViewsUnderPressure`
 *    is its only entry point (`globalServicesInit`'s `evictCachedProjectViews`
 *    reaches it by instance lookup), and it is kept a non-private instance
 *    method for exactly this kind of override, so stubbing it removes the
 *    competing pass without touching the candidate ordering being asserted.
 *    Off the ordinary cadence tier 2 is minutes away, but focus regain fires an
 *    out-of-band poll and this bucket shares one display, so this is cheaper
 *    than reasoning about the ladder. Loosening the assertion to tolerate a
 *    missing A instead would mask the exact regression the negative control
 *    proves this catches.
 *
 * 2. `ResourceProfileService.applyCurrentProfileTo()` re-arms the pressure
 *    policy from a deferred init task and on every profile transition, so a
 *    threshold nulled once at setup can be quietly overwritten later. It is
 *    re-asserted here — and read back — on every call rather than once.
 */
async function configurePvm(app: AppContext["app"], limit: number): Promise<PvmConfigureResult> {
  return app.evaluate((_electron, n) => {
    const g = globalThis as Record<string, unknown>;
    const getPvm = g.__daintreeGetPvm as (() => unknown) | undefined;
    const pvm = getPvm?.() as
      | (ProbedPvm & {
          setCachedViewLimit: (n: number) => void;
          setLowMemoryFreeThresholdMb: (mb: number | null) => void;
          getLowMemoryFreeThresholdMb: () => number | null;
          reclaimCachedViewsUnderPressure: () => number;
        })
      | null
      | undefined;
    if (!pvm) throw new Error("[bound-view-eviction] __daintreeGetPvm returned no manager");

    pvm.reclaimCachedViewsUnderPressure = () => 0;
    pvm.setLowMemoryFreeThresholdMb(null);
    const lowMemoryFloorMb = pvm.getLowMemoryFreeThresholdMb();
    const forcedReclaimStubbed = Object.prototype.hasOwnProperty.call(
      pvm,
      "reclaimCachedViewsUnderPressure"
    );
    pvm.setCachedViewLimit(n);
    return { lowMemoryFloorMb, forcedReclaimStubbed };
  }, limit);
}

/** Both isolation measures held at the moment the pass ran. */
function expectIsolated(result: PvmConfigureResult): void {
  expect(
    result.lowMemoryFloorMb,
    "the memory-pressure policy was re-armed under the test — a pressure pass could evict the wrong view"
  ).toBeNull();
  expect(
    result.forcedReclaimStubbed,
    "the forced tier-2 reclaim was not stubbed — it collapses the cache to the active view"
  ).toBe(true);
}

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];
let projectIdA = "";
let projectIdB = "";
let projectIdC = "";
let endpoint: McpEndpoint;

/**
 * Re-establish {A oldest cached, B younger cached, C active} from whatever the
 * previous test left behind, and wait out the switch bridge — the pass skips
 * the outgoing view, so triggering while it is still set would let B escape on
 * a slow runner and evict A instead, which reads exactly like a regression.
 */
async function arrangeThreeViews(): Promise<void> {
  ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
  ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
  ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_C);
  await expect
    .poll(
      async () => {
        const state = await readPvmState(ctx.app);
        return state.views.length === CACHE_LIMIT_ARRANGED && !state.outgoingBridgeProjectId;
      },
      { timeout: T_LONG, intervals: [200, 400, 800] }
    )
    .toBe(true);
}

async function evictDownToTwo(label: string): Promise<string[]> {
  expectIsolated(await configurePvm(ctx.app, CACHE_LIMIT_TRIGGER));
  await expect
    .poll(async () => (await readPvmState(ctx.app)).views.length, {
      timeout: T_LONG,
      intervals: [200, 400, 800],
    })
    .toBe(CACHE_LIMIT_TRIGGER);
  const survivors = (await readPvmState(ctx.app)).views.map((v) => v.projectId);
  console.log(`[bound-view-eviction] ${label} survivors`, JSON.stringify(survivors));
  return survivors;
}

test.describe.serial("MCP: a bound session's view outranks LRU under eviction (#11790)", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const fixtures = createFixtureRepos(3);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    const [repoA, repoB, repoC] = fixtures.map((f) => f.dir);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A);
    const first = await readPvmState(ctx.app);
    expect(
      first.ok,
      "__daintreeGetPvm is not wired — every view reading below would be vacuous"
    ).toBe(true);
    projectIdA = first.activeProjectId ?? "";
    expectIsolated(await configurePvm(ctx.app, CACHE_LIMIT_ARRANGED));

    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoB, PROJECT_B);
    projectIdB = (await readPvmState(ctx.app)).activeProjectId ?? "";
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoC, PROJECT_C);
    projectIdC = (await readPvmState(ctx.app)).activeProjectId ?? "";
    expect(
      new Set([projectIdA, projectIdB, projectIdC]).size,
      "the three fixtures did not resolve to three distinct workspace ids"
    ).toBe(3);

    const enabled = await (ctx.window as Page).evaluate(() =>
      (
        window as unknown as {
          electron: { mcpServer: { setEnabled: (on: boolean) => Promise<{ apiKey?: string }> } };
        }
      ).electron.mcpServer.setEnabled(true)
    );
    const readStatus = () =>
      (ctx.window as Page).evaluate(() =>
        (
          window as unknown as {
            electron: { mcpServer: { getStatus: () => Promise<{ port: number; apiKey: string }> } };
          }
        ).electron.mcpServer.getStatus()
      );
    await expect
      .poll(async () => (await readStatus()).port, { timeout: T_LONG, intervals: [200, 400, 800] })
      .toBeTruthy();

    const ready = await readStatus();
    // `||`, not `??`: getStatus reports `this.apiKey ?? ""`, so a server that
    // hasn't minted its key yet returns an empty string, and nullish-coalescing
    // would carry that through as a bare `Bearer ` and an opaque 401.
    const apiKey = ready.apiKey || enabled?.apiKey || "";
    expect(apiKey, "MCP server reported no API key after being enabled").toBeTruthy();
    endpoint = { port: ready.port, apiKey };
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("with nothing bound, pure LRU evicts the oldest cached view", async () => {
    expectIsolated(await configurePvm(ctx.app, CACHE_LIMIT_ARRANGED));
    await arrangeThreeViews();

    const before = await readPvmState(ctx.app);
    expect(before.activeProjectId).toBe(projectIdC);
    const lastUsed = Object.fromEntries(before.views.map((v) => [v.projectId, v.lastUsed]));
    expect(
      lastUsed[projectIdA],
      "A is not the LRU-oldest cached view, so this run never posed the question"
    ).toBeLessThan(lastUsed[projectIdB]);
    // Nothing is protected: a stray binding, an in-flight lease, or a throwing
    // activity callback would each deprioritize a view and decide this for us.
    expect(
      before.views.filter((v) => v.liveBinding || v.dispatchLease || v.unknown),
      "a view was already protected before the control ran"
    ).toEqual([]);
    console.log("[bound-view-eviction] control before", JSON.stringify(before));

    const survivors = await evictDownToTwo("control");
    expect(survivors).toContain(projectIdC);
    expect(survivors).toContain(projectIdB);
    expect(survivors).not.toContain(projectIdA);
  });

  test("a live MCP binding on the oldest view inverts LRU — the younger view dies", async () => {
    expectIsolated(await configurePvm(ctx.app, CACHE_LIMIT_ARRANGED));
    await arrangeThreeViews();

    const session = await initializeSession(endpoint, {
      workspaceId: projectIdA,
      clientName: "bound-to-A",
    });
    expect(
      session.boundTo,
      "the handshake did not bind to A, so nothing downstream is about a bound view"
    ).toBe(projectIdA);

    // The binding has to reach the PVM for a workspace whose view is CACHED,
    // not active — that reachability is half of what this spec proves.
    await expect
      .poll(
        async () => {
          const state = await readPvmState(ctx.app);
          return state.views.find((v) => v.projectId === projectIdA)?.liveBinding ?? false;
        },
        { timeout: T_LONG, intervals: [200, 400, 800] }
      )
      .toBe(true);

    const before = await readPvmState(ctx.app);
    expect(before.activeProjectId).toBe(projectIdC);
    const lastUsed = Object.fromEntries(before.views.map((v) => [v.projectId, v.lastUsed]));
    // The whole point: A is still the oldest, so pure LRU would take it.
    expect(
      lastUsed[projectIdA],
      "A is not the LRU-oldest cached view, so surviving proves nothing"
    ).toBeLessThan(lastUsed[projectIdB]);
    const viewB = before.views.find((v) => v.projectId === projectIdB);
    expect(
      {
        liveBinding: viewB?.liveBinding,
        dispatchLease: viewB?.dispatchLease,
        unknown: viewB?.unknown,
      },
      "B is not an unprotected candidate, so its eviction would not be attributable to A's binding"
    ).toEqual({ liveBinding: false, dispatchLease: false, unknown: false });
    console.log("[bound-view-eviction] bound before", JSON.stringify(before));

    const survivors = await evictDownToTwo("bound");
    expect(survivors).toContain(projectIdC);
    expect(survivors, "the bound older view did not outrank the unbound younger one").toContain(
      projectIdA
    );
    expect(survivors).not.toContain(projectIdB);
  });
});
