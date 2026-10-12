import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PluginSettingsStore } from "../PluginSettingsStore.js";
import {
  SecretStorageTimeoutError,
  type DecryptedSecret,
  type SecretCipher,
  type SecretStorageTier,
} from "../plugin/secretCipher.js";

let tmpDir: string;

type FakeCipher = SecretCipher & {
  encryptCalls: string[];
  decryptCalls: Array<{ cipher: string; legacy: boolean }>;
  /** Ciphertexts whose decrypt reports a superseded key. */
  stale: Set<string>;
};

/**
 * Reversible fake keychain. `encrypt` wraps the plaintext in a marker + base64 so
 * a round-trip is verifiable and the on-disk ciphertext is distinguishable from
 * the plaintext. `available` toggles the keychain-unavailable fallback path.
 */
function fakeCipher(available = true): FakeCipher {
  const encryptCalls: string[] = [];
  const decryptCalls: FakeCipher["decryptCalls"] = [];
  const stale = new Set<string>();
  return {
    encryptCalls,
    decryptCalls,
    stale,
    tier(): SecretStorageTier {
      return available ? "keychain" : "unavailable";
    },
    async encrypt(plaintext: string): Promise<string | null> {
      if (!available) return null;
      encryptCalls.push(plaintext);
      return seal(plaintext);
    },
    async decrypt(ciphertextBase64, options): Promise<DecryptedSecret> {
      decryptCalls.push({ cipher: ciphertextBase64, legacy: options?.legacy === true });
      const decoded = Buffer.from(ciphertextBase64, "base64").toString("utf-8");
      if (!decoded.startsWith("enc:")) throw new Error("not a fake ciphertext");
      return { plaintext: decoded.slice("enc:".length), reencrypt: stale.has(ciphertextBase64) };
    },
  };
}

function seal(plaintext: string): string {
  return Buffer.from(`enc:${plaintext}`, "utf-8").toString("base64");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** An envelope as builds before the async API wrote it: no `async` marker. */
function legacyEnvelope(plaintext: string) {
  return { __daintreeSecret: "daintree:secret:v1", cipher: seal(plaintext) };
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

    // On disk it is an envelope marked as the async API's, and the plaintext
    // never appears.
    const raw = await readRaw(filePath);
    const stored = raw.token as { __daintreeSecret: string; cipher: string; async?: boolean };
    expect(stored.__daintreeSecret).toBe("daintree:secret:v1");
    expect(typeof stored.cipher).toBe("string");
    expect(stored.async).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("sk-live-123");
    expect(cipher.decryptCalls).toEqual([{ cipher: stored.cipher, legacy: false }]);

    expect(store.secretTier()).toBe("keychain");
    expect(await store.storedSecretTier("token")).toBe("keychain");
  });

  it("refuses a secret write when the keychain is unavailable, touching neither memory nor disk", async () => {
    const cipher = fakeCipher(false);
    const filePath = path.join(tmpDir, "acme.plugin.json");
    const store = new PluginSettingsStore(filePath, cipher);

    await expect(store.set("token", "fallback-secret", { secret: true })).rejects.toThrow(
      /Secure storage is unavailable on this device, so the secret "token" wasn't saved/
    );
    await expect(fs.access(filePath)).rejects.toThrow();
    expect(await store.get<string>("token", { secret: true })).toBeUndefined();
    expect(await store.storedSecretTier("token")).toBeUndefined();
    expect(store.secretTier()).toBe("unavailable");

    // The write chain survives the refusal, and a later ordinary write can't
    // carry the refused value to disk through the shared cache.
    expect(await store.set("endpoint", "https://x")).toBe(true);
    expect(await readRaw(filePath)).toEqual({ endpoint: "https://x" });
  });

  it("keeps an existing encrypted secret when a rewrite is refused", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    await new PluginSettingsStore(filePath, fakeCipher(true)).set("token", "sk-old", {
      secret: true,
    });
    const before = await fs.readFile(filePath, "utf-8");

    const store = new PluginSettingsStore(filePath, fakeCipher(false));
    await expect(store.set("token", "sk-new", { secret: true })).rejects.toThrow(
      /Secure storage is unavailable/
    );
    expect(await fs.readFile(filePath, "utf-8")).toBe(before);
    expect(await store.storedSecretTier("token")).toBe("keychain");
  });

  it("migrates an existing plaintext secret to a keychain envelope on next write", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    // Seed a value an older Daintree wrote in plaintext when it had no keychain.
    await fs.writeFile(filePath, JSON.stringify({ token: "old-token" }), "utf-8");

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
      encrypt: async (p) => Buffer.from(`enc:${counter++}:${p}`, "utf-8").toString("base64"),
      decrypt: async (c) => {
        const decoded = Buffer.from(c, "base64").toString("utf-8");
        return { plaintext: decoded.replace(/^enc:\d+:/, ""), reencrypt: false };
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

describe("PluginSettingsStore secrets the sync safeStorage API wrote", () => {
  /**
   * Resolves once every write queued so far has run: a delete of an absent key
   * goes through the same write chain and changes nothing.
   */
  const writesSettled = (store: PluginSettingsStore) => store.delete("__no_such_key__");

  async function seed(filePath: string, values: Record<string, unknown>) {
    await fs.writeFile(filePath, JSON.stringify(values), "utf-8");
  }

  it("reads an envelope without the async marker as legacy and leaves it while it still reads", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    await seed(filePath, { token: legacyEnvelope("sk-old") });
    const before = await fs.readFile(filePath, "utf-8");
    const cipher = fakeCipher(true);
    const store = new PluginSettingsStore(filePath, cipher);

    expect(await store.get<string>("token", { secret: true })).toBe("sk-old");
    expect(cipher.decryptCalls).toEqual([{ cipher: seal("sk-old"), legacy: true }]);
    expect(await store.storedSecretTier("token")).toBe("keychain");

    await writesSettled(store);
    expect(await fs.readFile(filePath, "utf-8")).toBe(before);
    expect(cipher.encryptCalls).toEqual([]);
  });

  it("rewrites a legacy envelope through the async API on its next write, even unchanged", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    await seed(filePath, { token: legacyEnvelope("sk-old") });
    const cipher = fakeCipher(true);
    const store = new PluginSettingsStore(filePath, cipher);

    expect(await store.set("token", "sk-old", { secret: true })).toBe(true);

    expect((await readRaw(filePath)).token).toEqual({
      __daintreeSecret: "daintree:secret:v1",
      cipher: seal("sk-old"),
      async: true,
    });
    // No decrypt on the way: a legacy value may need the sync API to read, and
    // a write replaces it whatever it holds.
    expect(cipher.decryptCalls).toEqual([]);
    expect(await store.get<string>("token", { secret: true })).toBe("sk-old");
  });

  it("re-encrypts in the background a secret whose key the read found superseded", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    await seed(filePath, { token: legacyEnvelope("sk-old"), endpoint: "https://x" });
    const cipher = fakeCipher(true);
    cipher.stale.add(seal("sk-old"));
    const store = new PluginSettingsStore(filePath, cipher);

    expect(await store.get<string>("token", { secret: true })).toBe("sk-old");
    await writesSettled(store);

    expect(await readRaw(filePath)).toEqual({
      token: { __daintreeSecret: "daintree:secret:v1", cipher: seal("sk-old"), async: true },
      endpoint: "https://x",
    });
    expect(cipher.encryptCalls).toEqual(["sk-old"]);
  });

  it("keeps the old ciphertext when the keychain won't encrypt the rewrite", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    await seed(filePath, { token: legacyEnvelope("sk-old") });
    const before = await fs.readFile(filePath, "utf-8");
    const cipher = fakeCipher(false);
    cipher.stale.add(seal("sk-old"));
    const store = new PluginSettingsStore(filePath, cipher);

    expect(await store.get<string>("token", { secret: true })).toBe("sk-old");
    await writesSettled(store);

    expect(await fs.readFile(filePath, "utf-8")).toBe(before);
  });

  it("never lets a background re-encrypt undo a write that landed first", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    await seed(filePath, { token: legacyEnvelope("sk-old") });
    const cipher = fakeCipher(true);
    cipher.stale.add(seal("sk-old"));
    const store = new PluginSettingsStore(filePath, cipher);

    const read = store.get<string>("token", { secret: true });
    const write = store.set("token", "sk-new", { secret: true });
    expect(await read).toBe("sk-old");
    expect(await write).toBe(true);
    await writesSettled(store);

    expect(await store.get<string>("token", { secret: true })).toBe("sk-new");
    expect(cipher.encryptCalls).toEqual(["sk-new"]);
  });

  it("drops a background re-encrypt when the file changes while the keychain encrypts", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    await seed(filePath, { token: legacyEnvelope("sk-old") });
    const cipher = fakeCipher(true);
    cipher.stale.add(seal("sk-old"));
    const encrypt = cipher.encrypt.bind(cipher);
    const reached = deferred();
    const release = deferred();
    cipher.encrypt = async (plaintext) => {
      reached.resolve();
      await release.promise;
      return encrypt(plaintext);
    };
    const store = new PluginSettingsStore(filePath, cipher);

    expect(await store.get<string>("token", { secret: true })).toBe("sk-old");
    await reached.promise;
    await seed(filePath, { token: legacyEnvelope("sk-other") });
    release.resolve();
    await writesSettled(store);

    expect((await readRaw(filePath)).token).toEqual(legacyEnvelope("sk-other"));
  });

  it("writes an unchanged value when the file changed while the old one decrypted", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    const cipher = fakeCipher(true);
    const store = new PluginSettingsStore(filePath, cipher);
    await store.set("token", "sk-1", { secret: true });
    const decrypt = cipher.decrypt.bind(cipher);
    const reached = deferred();
    const release = deferred();
    cipher.decrypt = async (ciphertext, options) => {
      reached.resolve();
      await release.promise;
      return decrypt(ciphertext, options);
    };

    const write = store.set("token", "sk-1", { secret: true });
    await reached.promise;
    await seed(filePath, { endpoint: "https://x" });
    release.resolve();

    expect(await write).toBe(true);
    const raw = await readRaw(filePath);
    expect(raw.endpoint).toBe("https://x");
    expect(raw.token).toMatchObject({ cipher: seal("sk-1"), async: true });
  });

  it("rewrites an unchanged secret whose key the decrypt reports superseded", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    const cipher = fakeCipher(true);
    const store = new PluginSettingsStore(filePath, cipher);
    await store.set("token", "sk-1", { secret: true });
    cipher.stale.add(seal("sk-1"));

    expect(await store.set("token", "sk-1", { secret: true })).toBe(true);
    expect(cipher.encryptCalls).toEqual(["sk-1", "sk-1"]);
  });

  it("replaces a stored secret it can no longer decrypt", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    await seed(filePath, {
      token: { __daintreeSecret: "daintree:secret:v1", cipher: "AAAA", async: true },
    });
    const store = new PluginSettingsStore(filePath, fakeCipher(true));

    await expect(store.get("token", { secret: true })).rejects.toThrow(/not a fake ciphertext/);
    expect(await store.set("token", "sk-new", { secret: true })).toBe(true);
    expect(await store.get<string>("token", { secret: true })).toBe("sk-new");
  });

  it("refuses a write the keychain didn't answer, touching neither memory nor disk", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    const cipher = fakeCipher(true);
    const timeout = new Error("Secure storage didn't answer within 60 s");
    cipher.encrypt = vi.fn<SecretCipher["encrypt"]>().mockRejectedValueOnce(timeout);
    const store = new PluginSettingsStore(filePath, cipher);

    await expect(store.set("token", "sk-1", { secret: true })).rejects.toBe(timeout);
    await expect(fs.access(filePath)).rejects.toThrow();

    // The write chain survives the refusal.
    expect(await store.set("endpoint", "https://x")).toBe(true);
    expect(await readRaw(filePath)).toEqual({ endpoint: "https://x" });
  });

  it("doesn't wait out a second timeout to encrypt once reading the old value timed out", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    const cipher = fakeCipher(true);
    const store = new PluginSettingsStore(filePath, cipher);
    await store.set("token", "sk-1", { secret: true });
    const before = await fs.readFile(filePath, "utf-8");
    const timeout = new SecretStorageTimeoutError(60_000);
    cipher.decrypt = () => Promise.reject(timeout);

    await expect(store.set("token", "sk-2", { secret: true })).rejects.toBe(timeout);
    expect(cipher.encryptCalls).toEqual(["sk-1"]);
    expect(await fs.readFile(filePath, "utf-8")).toBe(before);
  });
});
