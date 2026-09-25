import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

/**
 * Bring your own key, at the service level: the engine is handed the model provider and
 * key the user saved in Settings, and nothing when they saved none.
 *
 * Harness copied from `tierDerivation.test.ts`: `AssistantHostProcess` is mocked so the
 * environment can be read as it was CONSTRUCTED, without spawning anything.
 *
 * (Original harness note follows.)
 *
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
  app: { getPath: () => "/tmp/daintree-byok-test" },
  webContents: { fromId: () => undefined },
}));

const settings: {
  tier: string;
  modelProvider?: string;
  providerModels?: Record<string, string>;
  openRouterRouting?: { sort?: string; allowTraining?: boolean; zeroRetention?: boolean };
} = { tier: "action" };

/** Keys "saved" per provider, read through the real `assistantProviderEnv`. */
const savedKeys: Record<string, string> = {};
vi.mock("../assistantProviderKeys.js", () => ({
  assistantProviderEnv: (
    provider: string,
    model: string | undefined,
    routing?: { sort?: string; allowTraining?: boolean; zeroRetention?: boolean }
  ) =>
    savedKeys[provider]
      ? {
          provider,
          model: model?.trim() ?? "",
          key: savedKeys[provider],
          sort: provider === "openrouter" ? (routing?.sort ?? "latency") : "",
          dataCollection: provider === "openrouter" && !routing?.allowTraining ? "deny" : "",
          zdr: provider === "openrouter" && routing?.zeroRetention ? "true" : "",
        }
      : null,
}));
vi.mock("../../../ipc/handlers/helpAssistant.js", () => ({
  getHelpAssistantSettings: () => settings,
}));

/** The tier the MCP bearer is minted at, or null to simulate a failed provision. */
const provisionedTier: string | null = "action";
/** Whether the provisioned bearer has a control-plane URL (Daintree control on/off). */
const provisionedMcpUrl: string | null = "http://127.0.0.1:1/mcp";
vi.mock("../../HelpSessionService.js", () => ({
  helpSessionService: {
    provisionSession: () => {
      if (provisionedTier === null) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        sessionId: "help_1",
        sessionPath: "/tmp/daintree-byok-test/help_1",
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

describe("assistant host model provider", () => {
  beforeEach(() => {
    settings.tier = "action";
    delete settings.modelProvider;
    delete settings.providerModels;
    delete settings.openRouterRouting;
    for (const k of Object.keys(savedKeys)) delete savedKeys[k];
  });

  it("hands the engine the chosen provider and its saved key, leaving the model to the backend", async () => {
    settings.modelProvider = "baseten";
    settings.providerModels = {};
    savedKeys.baseten = "bt-user-key";
    const { env } = await startOnce();
    expect(env.DAINTREE_UPSTREAM_PROVIDER).toBe("baseten");
    expect(env.DAINTREE_UPSTREAM_API_KEY).toBe("bt-user-key");
    expect(env.DAINTREE_UPSTREAM_MODEL).toBeUndefined();
  });

  it("sends a model only when the user overrode the recommendation", async () => {
    settings.modelProvider = "openai";
    settings.providerModels = { openai: "gpt-6-sol", baseten: "ignored" };
    savedKeys.openai = "sk-user";
    const { env } = await startOnce();
    expect(env.DAINTREE_UPSTREAM_PROVIDER).toBe("openai");
    expect(env.DAINTREE_UPSTREAM_MODEL).toBe("gpt-6-sol");
  });

  it("sets nothing when no key is saved for the chosen provider", async () => {
    settings.modelProvider = "openrouter";
    savedKeys.baseten = "a-key-for-a-different-provider";
    const { env } = await startOnce();
    expect(Object.keys(env).filter((k) => k.startsWith("DAINTREE_UPSTREAM_"))).toEqual([]);
  });

  it("falls back to OpenAI when the stored provider is missing or unknown", async () => {
    settings.modelProvider = "not-a-provider";
    savedKeys.openai = "sk-key";
    const { env } = await startOnce();
    expect(env.DAINTREE_UPSTREAM_PROVIDER).toBe("openai");
  });

  it("hands OpenRouter its routing preferences, and no other provider any", async () => {
    settings.modelProvider = "openrouter";
    settings.openRouterRouting = { sort: "price", allowTraining: false, zeroRetention: true };
    savedKeys.openrouter = "sk-or";
    const { env } = await startOnce();
    expect(env.DAINTREE_UPSTREAM_SORT).toBe("price");
    expect(env.DAINTREE_UPSTREAM_DATA_COLLECTION).toBe("deny");
    expect(env.DAINTREE_UPSTREAM_ZDR).toBe("true");

    settings.modelProvider = "openai";
    savedKeys.openai = "sk-oa";
    const openai = await startOnce();
    expect(Object.keys(openai.env).filter((k) => /UPSTREAM_(SORT|DATA|ZDR)/.test(k))).toEqual([]);
  });
});
