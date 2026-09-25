import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const storeData = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn(() => storeData.value),
    set: vi.fn((_key: string, value: unknown) => {
      storeData.value = value;
    }),
  },
}));
vi.mock("electron", () => ({ safeStorage: undefined }));

import {
  assistantProviderEnv,
  assistantProviderEnvVars,
  clearAssistantProviderKey,
  getAssistantProviderKeyStatus,
  readAssistantProviderKey,
  saveAssistantProviderKey,
  setAssistantProviderKeyCipherForTests,
  testAssistantProviderKey,
} from "../assistantProviderKeys.js";

/** Reversible and visibly not plaintext, so a test can tell which path stored a key. */
const fakeKeychain = {
  tier: () => "keychain" as const,
  encrypt: (plain: string) => `enc:${Buffer.from(plain).toString("base64")}`,
  decrypt: (cipher: string) => Buffer.from(cipher.slice(4), "base64").toString(),
};

describe("assistant provider keys", () => {
  beforeEach(() => {
    storeData.value = undefined;
    setAssistantProviderKeyCipherForTests(fakeKeychain);
  });
  afterEach(() => setAssistantProviderKeyCipherForTests(null));

  it("stores a key encrypted, and tells the renderer only that it is saved", () => {
    const status = saveAssistantProviderKey("baseten", "  bt-secret-1234  ");
    expect(status.providers.baseten).toMatchObject({
      saved: true,
      hint: "1234",
      storage: "keychain",
    });
    expect(status.providers.openai).toMatchObject({ saved: false, hint: null, storage: null });
    expect(JSON.stringify(storeData.value)).not.toContain("bt-secret-1234");
    expect(readAssistantProviderKey("baseten")).toBe("bt-secret-1234");
  });

  it("falls back to the settings file where there is no keychain, and says so", () => {
    setAssistantProviderKeyCipherForTests({
      ...fakeKeychain,
      tier: () => "unavailable",
      encrypt: () => null,
    });
    const status = saveAssistantProviderKey("openai", "sk-plain-9999");
    expect(status.providers.openai.storage).toBe("plaintext");
    expect(readAssistantProviderKey("openai")).toBe("sk-plain-9999");
  });

  it("refuses a mangled paste and an unknown provider", () => {
    expect(() => saveAssistantProviderKey("openai", "sk has space")).toThrow(/spaces/);
    expect(() => saveAssistantProviderKey("openai", "")).toThrow(/Enter a key/);
    expect(() => saveAssistantProviderKey("anthropic", "sk-x")).toThrow(/Unknown/);
  });

  it("refuses a save started before another window changed the key", () => {
    const before = getAssistantProviderKeyStatus().providers.openai.revision;
    saveAssistantProviderKey("openai", "sk-from-window-b");
    expect(() => saveAssistantProviderKey("openai", "sk-from-window-a", before)).toThrow(
      /another window/
    );
    expect(readAssistantProviderKey("openai")).toBe("sk-from-window-b");
    const now = getAssistantProviderKeyStatus().providers.openai.revision;
    saveAssistantProviderKey("openai", "sk-current", now);
    expect(readAssistantProviderKey("openai")).toBe("sk-current");
  });

  it("forgets a key", () => {
    saveAssistantProviderKey("openrouter", "sk-or-abcd");
    expect(clearAssistantProviderKey("openrouter").providers.openrouter.saved).toBe(false);
    expect(readAssistantProviderKey("openrouter")).toBeNull();
  });

  it("treats a key the keychain can no longer decrypt as absent", () => {
    saveAssistantProviderKey("baseten", "bt-key");
    setAssistantProviderKeyCipherForTests({
      ...fakeKeychain,
      decrypt: () => {
        throw new Error("keychain reset");
      },
    });
    expect(readAssistantProviderKey("baseten")).toBeNull();
    expect(getAssistantProviderKeyStatus().providers.baseten.saved).toBe(false);
  });

  it("reports whether a new key would go to the keychain, before any is saved", () => {
    expect(getAssistantProviderKeyStatus().keychain).toBe(true);
    setAssistantProviderKeyCipherForTests({
      ...fakeKeychain,
      tier: () => "unavailable",
      encrypt: () => null,
    });
    expect(getAssistantProviderKeyStatus().keychain).toBe(false);
  });

  it("builds the engine env only when a key is saved for the chosen provider", () => {
    expect(assistantProviderEnv("baseten", undefined)).toBeNull();
    saveAssistantProviderKey("baseten", "bt-key");
    expect(assistantProviderEnv("baseten", " ")).toMatchObject({
      provider: "baseten",
      model: "",
      key: "bt-key",
      sort: "",
      dataCollection: "",
      zdr: "",
    });
    expect(assistantProviderEnv("baseten", "zai-org/GLM-5.3")?.model).toBe("zai-org/GLM-5.3");
    expect(assistantProviderEnv("openai", undefined)).toBeNull();
  });

  it("sends OpenRouter's routing preferences, refusing training unless allowed", () => {
    saveAssistantProviderKey("openrouter", "sk-or-key");
    expect(assistantProviderEnvVars({ modelProvider: "openrouter" })).toEqual({
      DAINTREE_UPSTREAM_PROVIDER: "openrouter",
      DAINTREE_UPSTREAM_API_KEY: "sk-or-key",
      DAINTREE_UPSTREAM_SORT: "latency",
      DAINTREE_UPSTREAM_DATA_COLLECTION: "deny",
    });
    expect(
      assistantProviderEnvVars({
        modelProvider: "openrouter",
        providerModels: { openrouter: "anthropic/claude-sonnet-4.5" },
        openRouterRouting: { sort: "price", allowTraining: true, zeroRetention: true },
      })
    ).toEqual({
      DAINTREE_UPSTREAM_PROVIDER: "openrouter",
      DAINTREE_UPSTREAM_API_KEY: "sk-or-key",
      DAINTREE_UPSTREAM_MODEL: "anthropic/claude-sonnet-4.5",
      DAINTREE_UPSTREAM_SORT: "price",
      DAINTREE_UPSTREAM_ZDR: "true",
    });
  });

  it("never sends routing preferences to a provider other than OpenRouter", () => {
    saveAssistantProviderKey("openai", "sk-oa");
    const env = assistantProviderEnvVars({
      modelProvider: "openai",
      openRouterRouting: { sort: "price", allowTraining: false, zeroRetention: true },
    });
    expect(Object.keys(env).sort()).toEqual([
      "DAINTREE_UPSTREAM_API_KEY",
      "DAINTREE_UPSTREAM_PROVIDER",
    ]);
  });

  it("defaults to OpenAI, and sets nothing without a saved key", () => {
    expect(assistantProviderEnvVars({})).toEqual({});
    saveAssistantProviderKey("openai", "sk-default");
    expect(assistantProviderEnvVars({}).DAINTREE_UPSTREAM_PROVIDER).toBe("openai");
  });

  describe("checking a key with the provider", () => {
    it("asks each provider's free authenticated endpoint with a bearer", async () => {
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
      for (const [provider, url] of [
        ["baseten", "https://inference.baseten.co/v1/models"],
        ["openrouter", "https://openrouter.ai/api/v1/key"],
        ["openai", "https://api.openai.com/v1/models"],
      ] as const) {
        const result = await testAssistantProviderKey(provider, "typed-key", fetchImpl);
        expect(result.accepted).toBe(true);
        expect(fetchImpl).toHaveBeenLastCalledWith(
          url,
          expect.objectContaining({
            headers: expect.objectContaining({ Authorization: "Bearer typed-key" }),
          })
        );
      }
    });

    it("reports a rejection, an outage and an unreachable host distinctly", async () => {
      const status = (code: number) => vi.fn(async () => new Response("{}", { status: code }));
      expect((await testAssistantProviderKey("openai", "k", status(401))).message).toMatch(
        /rejected/
      );
      expect((await testAssistantProviderKey("openai", "k", status(503))).message).toMatch(
        /HTTP 503/
      );
      const offline = vi.fn(async () => {
        throw new Error("offline");
      });
      expect((await testAssistantProviderKey("openai", "k", offline)).message).toMatch(/reach/);
    });

    it("checks the saved key when none is typed, and says when there is none", async () => {
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
      expect((await testAssistantProviderKey("baseten", "", fetchImpl)).message).toMatch(/No key/);
      saveAssistantProviderKey("baseten", "bt-saved");
      await testAssistantProviderKey("baseten", "", fetchImpl);
      expect(fetchImpl).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer bt-saved" }),
        })
      );
    });
  });
});
