import { describe, expect, it, vi } from "vitest";

// Vitest resolves imports through Vite, so the fixture's Node loader hook never
// fires here. Hand the same stand-in to Vite's resolver instead, so the suite
// drives the identical seam the perf runner does.
vi.mock("electron", async () => (await import("../lib/mcpSessionFixture")).perfMcpElectronStub);

import {
  expectedExposedIds,
  forbiddenCallSample,
  loadMcpModules,
  loadRealManifest,
  MCP_TIERS,
  openSession,
  PERF_WORKSPACE_BINDING,
  permittedCallSample,
  probeCall,
  readResultPayload,
} from "../lib/mcpSessionFixture";
import { mcpSessionScenarios } from "../scenarios/mcpSession";

/**
 * PERF-280..285 drive the real `createSessionServer`, the real SDK request
 * handlers and the real `SessionStore` against the real action manifest, which
 * `actionDispatchFixture` links with esbuild. Two graphs can break without
 * breaking anything else: an `electron` value import creeping into the MCP
 * module chain, and a renamed export on either side of the fixture boundary.
 *
 * The perf run that would catch either gates nothing and is not on PRs, so
 * these link both graphs in ordinary CI and exercise each measured gate once.
 * The scenarios' own timing loops are not run here.
 */
const BUNDLE_TIMEOUT_MS = 180_000;

async function harness() {
  const [mods, manifest] = await Promise.all([loadMcpModules(), loadRealManifest()]);
  return { mods, manifest };
}

describe("mcp session perf fixture", () => {
  it(
    "completes a real MCP handshake and advertises the shipped instructions",
    async () => {
      const { mods, manifest } = await harness();
      const session = await openSession(mods, manifest, { tier: "system" });
      try {
        expect(session.client.getInstructions()).toBe(mods.MCP_SERVER_INSTRUCTIONS);
        const capabilities = session.client.getServerCapabilities();
        expect(capabilities?.tools?.listChanged).toBe(true);
        expect(capabilities?.resources?.subscribe).toBe(true);
        expect(capabilities?.experimental?.[mods.WORKSPACE_BINDING_CAPABILITY_KEY]).toBeUndefined();
        expect(session.serverOutBytes).toBeGreaterThan(0);
      } finally {
        await session.close();
      }
    },
    BUNDLE_TIMEOUT_MS
  );

  it(
    "echoes the workspace binding and withholds confirm-gated tools from a bound session",
    async () => {
      const { mods, manifest } = await harness();
      const session = await openSession(mods, manifest, {
        tier: "external",
        workspaceBinding: PERF_WORKSPACE_BINDING,
      });
      try {
        expect(
          session.client.getServerCapabilities()?.experimental?.[
            mods.WORKSPACE_BINDING_CAPABILITY_KEY
          ]
        ).toEqual(PERF_WORKSPACE_BINDING);
        const listed = new Set((await session.client.listTools()).tools.map((t) => t.name));
        expect(listed).toEqual(expectedExposedIds(manifest, "external", true));
        // The bound surface is strictly smaller — otherwise the ceiling is a
        // no-op and the equality above proves nothing.
        expect(listed.size).toBeLessThan(expectedExposedIds(manifest, "external", false).size);
      } finally {
        await session.close();
      }
    },
    BUNDLE_TIMEOUT_MS
  );

  it(
    "serves each tier the surface its allowlist permits, over the real transport",
    async () => {
      const { mods, manifest } = await harness();
      for (const tier of MCP_TIERS) {
        const session = await openSession(mods, manifest, { tier });
        try {
          const measured = await session.measureServerBytes(() => session.client.listTools());
          const listed = new Set(measured.value.tools.map((tool) => tool.name));
          expect(listed).toEqual(expectedExposedIds(manifest, tier, false));
          expect(measured.bytes).toBeGreaterThan(0);
          for (const tool of measured.value.tools) {
            expect(tool.inputSchema?.["type"]).toBe("object");
          }
        } finally {
          await session.close();
        }
      }
    },
    BUNDLE_TIMEOUT_MS
  );

  it(
    "admits a permitted call and refuses a withheld one with the tier code",
    async () => {
      const { mods, manifest } = await harness();
      const session = await openSession(mods, manifest, { tier: "external" });
      try {
        const permitted = permittedCallSample(manifest, "external", 1)[0]!;
        const forbidden = forbiddenCallSample(manifest, "external", 1)[0]!;
        expect(await probeCall(session, permitted, {})).toMatchObject({ ok: true });
        expect(await probeCall(session, forbidden, {})).toMatchObject({
          ok: false,
          code: mods.TIER_NOT_PERMITTED_CODE,
        });
      } finally {
        await session.close();
      }
    },
    BUNDLE_TIMEOUT_MS
  );

  it(
    "refuses every request once the session is revoked",
    async () => {
      const { mods, manifest } = await harness();
      const session = await openSession(mods, manifest, { tier: "system" });
      try {
        const target = permittedCallSample(manifest, "system", 1)[0]!;
        expect(await probeCall(session, target, {})).toMatchObject({ ok: true });
        session.revoke();
        expect(await probeCall(session, target, {})).toMatchObject({
          ok: false,
          code: mods.SESSION_GONE,
        });
        await expect(session.client.listTools()).rejects.toThrow();
      } finally {
        await session.close();
      }
    },
    BUNDLE_TIMEOUT_MS
  );

  it(
    "singleflights duplicate creations and replays the original result",
    async () => {
      const { mods, manifest } = await harness();
      const session = await openSession(mods, manifest, { tier: "system" });
      try {
        const args = { cwd: "/tmp/daintree-perf", requestKey: "unit-test-key" };
        const concurrent = await Promise.all([
          session.client.callTool({ name: "terminal.new", arguments: args }),
          session.client.callTool({ name: "terminal.new", arguments: args }),
          session.client.callTool({ name: "terminal.new", arguments: args }),
        ]);
        expect(session.dispatches).toHaveLength(1);
        const created = readResultPayload(concurrent[0]!).terminalId;
        expect(typeof created).toBe("string");

        const replay = await session.client.callTool({ name: "terminal.new", arguments: args });
        expect(session.dispatches).toHaveLength(1);
        expect(readResultPayload(replay).terminalId).toBe(created);

        // A distinct tool on the same key must still dispatch — otherwise the
        // suppression above is indistinguishable from a cache that eats
        // everything.
        await session.client.callTool({ name: "terminal.list", arguments: args });
        expect(session.dispatches).toHaveLength(2);

        const collision = await probeCall(session, "terminal.new", {
          cwd: "/tmp/daintree-perf/other",
          requestKey: "unit-test-key",
        });
        expect(collision.code).toBe(mods.MCP_DEDUP_KEY_COLLISION_CODE);
      } finally {
        await session.close();
      }
    },
    BUNDLE_TIMEOUT_MS
  );

  it(
    "records ownership from the dispatch envelope and refuses a foreign id",
    async () => {
      const { mods, manifest } = await harness();
      const session = await openSession(mods, manifest, { tier: "system" });
      try {
        const created = await session.client.callTool({
          name: "terminal.new",
          arguments: { cwd: "/tmp/daintree-perf" },
        });
        const terminalId = readResultPayload(created).terminalId as string;
        expect(
          session.store.resourceOwnership.owns(session.sessionId, "terminal", terminalId)
        ).toBe(true);
        expect(await probeCall(session, "terminal.closeOwned", { terminalId })).toMatchObject({
          ok: true,
        });
        expect(
          await probeCall(session, "terminal.closeOwned", { terminalId: "not-mine" })
        ).toMatchObject({ ok: false, code: mods.RESOURCE_NOT_OWNED_CODE });
      } finally {
        await session.close();
      }
    },
    BUNDLE_TIMEOUT_MS
  );
});

describe("mcp session scenario family", () => {
  it("declares the PERF-280..285 block and a miss count for each", () => {
    expect(mcpSessionScenarios.map((scenario) => scenario.id)).toEqual([
      "PERF-280",
      "PERF-281",
      "PERF-282",
      "PERF-283",
      "PERF-284",
      "PERF-285",
    ]);
    for (const scenario of mcpSessionScenarios) {
      expect(scenario.correctness?.length).toBeGreaterThan(0);
      // Warmups matter here: the first run() in a process pays the one-off
      // esbuild link and the MCP module load, and a measured iteration must
      // never carry either.
      expect(scenario.warmups ?? 0).toBeGreaterThan(0);
    }
  });
});
