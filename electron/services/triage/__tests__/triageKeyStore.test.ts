import { describe, expect, it, vi } from "vitest";

vi.mock("../../../store.js", () => ({ store: { get: vi.fn(), set: vi.fn() } }));
vi.mock("electron", () => ({ safeStorage: {} }));

import { TriageKeys, type TriageKeyStore } from "../triageKeyStore.js";
import type { SecretCipher } from "../../plugin/secretCipher.js";

function memoryBackend(): TriageKeyStore & { data: Record<string, string | undefined> } {
  const backend = {
    data: {} as Record<string, string | undefined>,
    read: () => ({ ...backend.data }),
    write: (keys: Record<string, string | undefined>) => {
      backend.data = { ...keys };
    },
  };
  return backend;
}

/** Reversible stand-in for the OS keychain, so stored values are visibly not plaintext. */
const reversingCipher: SecretCipher = {
  tier: () => "keychain",
  encrypt: (text) => Buffer.from([...text].reverse().join("")).toString("base64"),
  decrypt: (b64) => [...Buffer.from(b64, "base64").toString()].reverse().join(""),
};

const noKeychain: SecretCipher = {
  tier: () => "unavailable",
  encrypt: () => null,
  decrypt: () => {
    throw new Error("no keychain");
  },
};

describe("TriageKeys", () => {
  it("stores a saved key encrypted and reads it back", () => {
    const backend = memoryBackend();
    const keys = new TriageKeys(backend, reversingCipher, {});
    keys.save("classifier", "  ts-key-1234  ");
    expect(backend.data.classifier).toBeDefined();
    expect(backend.data.classifier).not.toContain("ts-key-1234");
    expect(keys.effective("classifier")).toBe("ts-key-1234");
  });

  it("refuses to save without a keychain rather than writing plaintext", () => {
    const backend = memoryBackend();
    const keys = new TriageKeys(backend, noKeychain, {});
    expect(() => keys.save("describer", "csk-abcd")).toThrow(/keychain/);
    expect(backend.data).toEqual({});
  });

  it("prefers a saved key over the environment, and falls back to it", () => {
    const backend = memoryBackend();
    const keys = new TriageKeys(backend, reversingCipher, { CEREBRAS_API_KEY: "env-key-9999" });
    expect(keys.effective("describer")).toBe("env-key-9999");
    expect(keys.status().keys.describer).toEqual({ source: "environment", hint: "9999" });

    keys.save("describer", "saved-key-5678");
    expect(keys.effective("describer")).toBe("saved-key-5678");
    expect(keys.status().keys.describer).toEqual({ source: "saved", hint: "5678" });

    keys.clear("describer");
    expect(keys.effective("describer")).toBe("env-key-9999");
  });

  it("accepts the JEV_API_KEY spelling for the classifier", () => {
    const keys = new TriageKeys(memoryBackend(), reversingCipher, { JEV_API_KEY: "jev-0001" });
    expect(keys.effective("classifier")).toBe("jev-0001");
  });

  it("treats unreadable ciphertext as no key", () => {
    const backend = memoryBackend();
    backend.data.classifier = "not-ciphertext";
    const keys = new TriageKeys(backend, noKeychain, {});
    expect(keys.effective("classifier")).toBeNull();
    expect(keys.status().keys.classifier.source).toBe("none");
  });

  it("rejects something that isn't shaped like a key", () => {
    const keys = new TriageKeys(memoryBackend(), reversingCipher, {});
    expect(() => keys.save("classifier", "two words")).toThrow();
    expect(() => keys.save("classifier", "   ")).toThrow();
  });

  it("never reports more of a key than its last four characters", () => {
    const keys = new TriageKeys(memoryBackend(), reversingCipher, {});
    keys.save("classifier", "ts-secret-value-abcd");
    expect(JSON.stringify(keys.status())).not.toContain("secret");
  });
});
