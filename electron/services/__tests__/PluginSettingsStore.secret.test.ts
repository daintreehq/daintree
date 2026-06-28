import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PluginSettingsStore } from "../PluginSettingsStore.js";
import type { SecretCipher, SecretStorageTier } from "../plugin/secretCipher.js";

let tmpDir: string;

/**
 * Reversible fake keychain. `encrypt` wraps the plaintext in a marker + base64 so
 * a round-trip is verifiable and the on-disk ciphertext is distinguishable from
 * the plaintext. `available` toggles the keychain-unavailable fallback path.
 */
function fakeCipher(available = true): SecretCipher & { encryptCalls: string[] } {
  const encryptCalls: string[] = [];
  return {
    encryptCalls,
    tier(): SecretStorageTier {
      return available ? "keychain" : "plaintext";
    },
    encrypt(plaintext: string): string | null {
      if (!available) return null;
      encryptCalls.push(plaintext);
      return Buffer.from(`enc:${plaintext}`, "utf-8").toString("base64");
    },
    decrypt(ciphertextBase64: string): string {
      const decoded = Buffer.from(ciphertextBase64, "base64").toString("utf-8");
      if (!decoded.startsWith("enc:")) throw new Error("not a fake ciphertext");
      return decoded.slice("enc:".length);
    },
  };
}

async function readRaw(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-secret-store-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PluginSettingsStore secret tier", () => {
  it("round-trips a secret through the cipher and stores ciphertext, not plaintext", async () => {
    const cipher = fakeCipher(true);
    const filePath = path.join(tmpDir, "acme.plugin.json");
    const store = new PluginSettingsStore(filePath, cipher);

    expect(await store.set("token", "sk-live-123", { secret: true })).toBe(true);
    expect(cipher.encryptCalls).toEqual(["sk-live-123"]);

    // get with the secret flag decrypts back to the original value.
    expect(await store.get<string>("token", { secret: true })).toBe("sk-live-123");

    // On disk it is an envelope, and the plaintext never appears.
    const raw = await readRaw(filePath);
    const stored = raw.token as { __daintreeSecret: string; cipher: string };
    expect(stored.__daintreeSecret).toBe("daintree:secret:v1");
    expect(typeof stored.cipher).toBe("string");
    expect(JSON.stringify(raw)).not.toContain("sk-live-123");

    expect(store.secretTier()).toBe("keychain");
    expect(await store.storedSecretTier("token")).toBe("keychain");
  });

  it("falls back to plaintext at rest when the keychain is unavailable", async () => {
    const cipher = fakeCipher(false);
    const filePath = path.join(tmpDir, "acme.plugin.json");
    const store = new PluginSettingsStore(filePath, cipher);

    await store.set("token", "fallback-secret", { secret: true });
    expect(await store.get<string>("token", { secret: true })).toBe("fallback-secret");

    // Stored as a bare string — no envelope — matching the legacy plaintext path.
    const raw = await readRaw(filePath);
    expect(raw.token).toBe("fallback-secret");

    expect(store.secretTier()).toBe("plaintext");
    expect(await store.storedSecretTier("token")).toBe("plaintext");
  });

  it("migrates an existing plaintext secret to a keychain envelope on next write", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    // Seed a value written under the old plaintext path (no keychain).
    const plaintextStore = new PluginSettingsStore(filePath, fakeCipher(false));
    await plaintextStore.set("token", "old-token", { secret: true });
    expect((await readRaw(filePath)).token).toBe("old-token");

    // A fresh store with a keychain now available rewrites it as an envelope on
    // re-save, even though the plaintext value is identical (tier change forces a write).
    const cipher = fakeCipher(true);
    const keychainStore = new PluginSettingsStore(filePath, cipher);
    expect(await keychainStore.storedSecretTier("token")).toBe("plaintext");
    expect(await keychainStore.set("token", "old-token", { secret: true })).toBe(true);

    const raw = await readRaw(filePath);
    expect((raw.token as { __daintreeSecret?: string }).__daintreeSecret).toBe(
      "daintree:secret:v1"
    );
    expect(JSON.stringify(raw)).not.toContain("old-token");
    expect(await keychainStore.get<string>("token", { secret: true })).toBe("old-token");
    expect(await keychainStore.storedSecretTier("token")).toBe("keychain");
  });

  it("treats an unchanged encrypted secret as a no-op despite non-deterministic ciphertext", async () => {
    let counter = 0;
    // Non-deterministic encrypt: a different ciphertext each call for the same input.
    const cipher: SecretCipher = {
      tier: () => "keychain",
      encrypt: (p) => Buffer.from(`enc:${counter++}:${p}`, "utf-8").toString("base64"),
      decrypt: (c) => {
        const decoded = Buffer.from(c, "base64").toString("utf-8");
        return decoded.replace(/^enc:\d+:/, "");
      },
    };
    const store = new PluginSettingsStore(path.join(tmpDir, "acme.plugin.json"), cipher);
    expect(await store.set("token", "same", { secret: true })).toBe(true);
    // Same plaintext: must compare decrypted plaintext, not raw ciphertext.
    expect(await store.set("token", "same", { secret: true })).toBe(false);
    expect(await store.set("token", "different", { secret: true })).toBe(true);
  });

  it("encrypts non-string secret values via JSON and decodes them back", async () => {
    const cipher = fakeCipher(true);
    const store = new PluginSettingsStore(path.join(tmpDir, "acme.plugin.json"), cipher);
    await store.set("creds", { id: 1, key: "abc" }, { secret: true });
    // The cipher saw the JSON-encoded form.
    expect(cipher.encryptCalls).toEqual([JSON.stringify({ id: 1, key: "abc" })]);
    // get returns the JSON string (the manager re-parses for the plugin/UI).
    expect(await store.get<string>("creds", { secret: true })).toBe(
      JSON.stringify({ id: 1, key: "abc" })
    );
  });

  it("leaves non-secret values untouched — no encryption, plaintext on disk", async () => {
    const cipher = fakeCipher(true);
    const filePath = path.join(tmpDir, "acme.plugin.json");
    const store = new PluginSettingsStore(filePath, cipher);

    await store.set("endpoint", "https://api.example.com");
    await store.set("retries", 3);
    await store.set("config", { nested: true });

    expect(cipher.encryptCalls).toEqual([]);
    expect(await store.get<string>("endpoint")).toBe("https://api.example.com");
    expect(await store.get<number>("retries")).toBe(3);

    const raw = await readRaw(filePath);
    expect(raw).toEqual({
      endpoint: "https://api.example.com",
      retries: 3,
      config: { nested: true },
    });
    // No stored value carries the secret envelope tag.
    expect(JSON.stringify(raw)).not.toContain("daintree:secret");
  });

  it("storedSecretTier is undefined for an unset key", async () => {
    const store = new PluginSettingsStore(path.join(tmpDir, "acme.plugin.json"), fakeCipher(true));
    expect(await store.storedSecretTier("missing")).toBeUndefined();
  });

  it("a plaintext-flagged read of an envelope does not leak ciphertext as the value", async () => {
    // Defense check: get() without the secret flag returns the raw envelope, not
    // a decrypted value — the manager always passes the flag for secret keys, so
    // this asserts the flag is what gates decryption (no accidental plaintext leak
    // path, and no silent decryption of a non-secret read).
    const cipher = fakeCipher(true);
    const store = new PluginSettingsStore(path.join(tmpDir, "acme.plugin.json"), cipher);
    await store.set("token", "sk-1", { secret: true });
    const rawValue = await store.get<{ __daintreeSecret?: string }>("token");
    expect(rawValue?.__daintreeSecret).toBe("daintree:secret:v1");
  });
});
