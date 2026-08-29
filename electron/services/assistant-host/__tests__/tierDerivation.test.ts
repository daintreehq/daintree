import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

/**
 * One tier, one derivation, at the service level.
 *
 * `engineTierBinding.test.ts` proves the ENGINE refuses a mismatched pair. This proves
 * `AssistantHostService` never produces one — which is the half that actually shipped
 * broken. The two halves are separate on purpose: the engine's check could keep working
 * perfectly while this service kept feeding it disagreeing values, which is exactly what
 * happened.
 *
 * `AssistantHostProcess` is mocked so the descriptor and the environment can be read as
 * they were CONSTRUCTED, without spawning anything. That is the seam the bug lived in —
 * both values are decided in `startLocked` and neither is observable from outside once
 * the child exists.
 */

const started: Array<{ descriptor: { tier: string }; env: Record<string, string> }> = [];

vi.mock("../AssistantHostProcess.js", () => ({
  AssistantHostProcess: class {
    constructor(opts: { descriptor: { tier: string }; env: Record<string, string> }) {
      started.push({ descriptor: opts.descriptor, env: opts.env });
    }
    start() {}
    waitForReady() {
      return Promise.resolve();
    }
    getReadyEvent() {
      return null;
    }
    getPid() {
      return null;
    }
    takePreReadyEvents() {
      return [];
    }
    dispose() {}
  },
}));

/**
 * Pin the platform for the whole file.
 *
 * `start()` refuses a platform the engine's project lock has no port for, and the unit
 * suite runs natively on a Windows release runner — so without this, every ordinary
 * lifecycle assertion below would be refused there for a reason that has nothing to do
 * with what it is testing. The refusal has its own test, which supplies `win32` itself.
 */
const REAL_PLATFORM = process.platform;
beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

vi.mock("../resolveAssistantBinary.js", () => ({
  ASSISTANT_BIN_ENV: "DAINTREE_ASSISTANT_BIN",
  resolveAssistantBinary: () =>
    Promise.resolve({ path: "/nonexistent/daintree-assistant", source: "repo" }),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-tier-test" },
  webContents: { fromId: () => undefined },
}));

const settings = { tier: "action" as string };
vi.mock("../../../ipc/handlers/helpAssistant.js", () => ({
  getHelpAssistantSettings: () => settings,
}));

/** The tier the MCP bearer is minted at, or null to simulate a failed provision. */
let provisionedTier: string | null = "action";
/** How provisioning fails when `provisionedTier` is null: the `else` branch or the catch. */
let provisionFailure: "null" | "throw" = "null";
/** Whether the provisioned bearer has a control-plane URL (Daintree control on/off). */
let provisionedMcpUrl: string | null = "http://127.0.0.1:1/mcp";
vi.mock("../../HelpSessionService.js", () => ({
  helpSessionService: {
    provisionSession: () => {
      if (provisionedTier === null) {
        return provisionFailure === "throw"
          ? Promise.reject(new Error("MCP server is not ready"))
          : Promise.resolve(null);
      }
      return Promise.resolve({
        sessionId: "help_1",
        sessionPath: "/tmp/daintree-tier-test/help_1",
        token: "tok",
        tier: provisionedTier,
        mcpUrl: provisionedMcpUrl,
        windowId: 1,
      });
    },
    markEngineSession: () => true,
    getDebugLoggingPreference: () => false,
    getDebugLogging: () => false,
    getBypassPermissions: () => false,
    revokeSession: () => Promise.resolve(),
  },
}));

const { AssistantHostService } = await import("../AssistantHostService.js");

async function startOnce() {
  started.length = 0;
  const service = new AssistantHostService();
  const result = await service.start({
    projectId: "p1",
    cwd: "/tmp/project",
    windowId: 1,
    webContentsId: 7,
  });
  expect(started).toHaveLength(1);
  return { ...started[0], result };
}

/**
 * Asserts a start took the SUCCESSFUL provisioning path.
 *
 * Without it, a mocked service method that quietly threw would drop the start into the
 * catch and the fallback tier — and every "follows the minted bearer" assertion below
 * would pass for entirely the wrong reason.
 */
function expectProvisioned(result: { mcpUnavailableReason: string | null }) {
  expect(result.mcpUnavailableReason).toBeNull();
}

describe("assistant host tier derivation", () => {
  beforeEach(() => {
    settings.tier = "action";
    provisionedTier = "action";
    provisionFailure = "null";
    provisionedMcpUrl = "http://127.0.0.1:1/mcp";
  });

  it("maps the action tier to the engine's operator tier, on both sides", async () => {
    // The regression itself. `action` is the shipped default, and it used to produce
    // descriptor `system` against environment `operator` — a pair the engine refuses.
    const { descriptor, env, result } = await startOnce();
    expectProvisioned(result);
    expect(env.DAINTREE_ASSISTANT_TIER).toBe("operator");
    expect(descriptor.tier).toBe("operator");
  });

  it("follows the tier the MCP bearer was actually minted at", async () => {
    // Not the settings value read a second time: a setting changed between provisioning
    // and spawn would leave the engine at one authority and its own bearer at another.
    settings.tier = "system";
    provisionedTier = "workbench";
    const { descriptor, env, result } = await startOnce();
    expectProvisioned(result);
    expect(descriptor.tier).toBe("supervisor");
    expect(env.DAINTREE_ASSISTANT_TIER).toBe("supervisor");
  });

  it("follows the minted tier even with the control plane switched off", async () => {
    // Daintree control being off does not mean provisioning failed — it returns a bearer
    // with no URL. Reading that as "no bearer" is how the old code reached its
    // `?? "workbench"` fallback on a session that had a perfectly good tier.
    provisionedMcpUrl = null;
    provisionedTier = "system";
    const { descriptor, env } = await startOnce();
    expect(descriptor.tier).toBe("system");
    expect(env.DAINTREE_ASSISTANT_TIER).toBe("system");
  });

  /**
   * The fallback path, at EVERY tier and through BOTH failure modes.
   *
   * Exhaustive on purpose. The old environment derivation was
   * `engineTierFor(mcp?.tier ?? "workbench")`, so a fallback test written only at
   * `workbench` agrees with the bug it is meant to catch. `action` and `system` are the
   * two that actually distinguish the fix.
   */
  for (const failure of ["null", "throw"] as const) {
    for (const { help, engine } of [
      { help: "workbench", engine: "supervisor" },
      { help: "action", engine: "operator" },
      { help: "system", engine: "system" },
    ]) {
      it(`agrees with itself at ${help} when provisioning ${failure === "throw" ? "throws" : "returns nothing"}`, async () => {
        provisionedTier = null;
        provisionFailure = failure;
        settings.tier = help;
        const { descriptor, env, result } = await startOnce();
        // Degraded, and SAYING so — the assertion below would otherwise be satisfied by
        // a start that quietly succeeded.
        expect(result.mcpUnavailableReason).not.toBeNull();
        expect(descriptor.tier).toBe(env.DAINTREE_ASSISTANT_TIER);
        expect(descriptor.tier).toBe(engine);
      });
    }
  }

  it("only ever sends a tier the engine recognises", async () => {
    // A stored value this build does not know must resolve DOWN to a real engine tier.
    // The engine's descriptor parser rejects a blank one outright, and its own resolver
    // treats an unrecognised one as its widest — so "something" is not good enough.
    settings.tier = "not-a-tier";
    provisionedTier = null;
    const { descriptor, env } = await startOnce();
    expect(["supervisor", "operator", "system"]).toContain(descriptor.tier);
    expect(env.DAINTREE_ASSISTANT_TIER).toBe(descriptor.tier);
  });
});
