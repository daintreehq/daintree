import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PluginSettingsStore, wipeSettingsFile } from "../PluginSettingsStore.js";
import {
  SecretStorageTimeoutError,
  type DecryptedSecret,
  type SecretCipher,
  type SecretStorageTier,
} from "../plugin/secretCipher.js";

let tmpDir: string;

function storeAt(...segments: string[]): { store: PluginSettingsStore; filePath: string } {
  const filePath = path.join(tmpDir, ...segments);
  return { store: new PluginSettingsStore(filePath), filePath };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-settings-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PluginSettingsStore", () => {
  it("returns undefined for an unset key when the file does not exist", async () => {
    const { store } = storeAt("missing", "acme.plugin.json");
    expect(await store.get("token")).toBeUndefined();
  });

  it("set creates the directory, persists JSON, and round-trips the value", async () => {
    const { store, filePath } = storeAt("nested", "dir", "acme.plugin.json");
    const changed = await store.set("token", "sk-test");
    expect(changed).toBe(true);
    expect(await store.get<string>("token")).toBe("sk-test");

    const raw = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ token: "sk-test" });
  });

  it("persists across store instances pointed at the same file", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("count", 3);
    await store.set("flag", true);

    const reopened = new PluginSettingsStore(filePath);
    expect(await reopened.get<number>("count")).toBe(3);
    expect(await reopened.get<boolean>("flag")).toBe(true);
  });

  const chmodIt = process.platform === "win32" ? it.skip : it;
  chmodIt("writes the file with mode 0o600", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("token", "secret");
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("set returns false for a no-op write of an equal value", async () => {
    const { store } = storeAt("acme.plugin.json");
    expect(await store.set("k", { a: 1 })).toBe(true);
    expect(await store.set("k", { a: 1 })).toBe(false);
    expect(await store.set("k", { a: 2 })).toBe(true);
  });

  it("rejects when the file contains invalid JSON", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ not json", "utf-8");
    await expect(store.get("token")).rejects.toThrow(/not valid JSON/);
  });

  it("rejects when the file contains a non-object JSON value", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify([1, 2, 3]), "utf-8");
    await expect(store.get("token")).rejects.toThrow(/must contain a JSON object/);
  });

  // Skipped where directory mode bits don't gate writes (Windows, or running
  // as root which bypasses permission checks).
  const rollbackIt = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;
  rollbackIt("rolls back the in-memory value when the write fails", async () => {
    const dir = path.join(tmpDir, "ro");
    await fs.mkdir(dir, { recursive: true });
    const store = new PluginSettingsStore(path.join(dir, "acme.plugin.json"));
    // Read+execute only: load() (readFile → ENOENT) still succeeds, but the
    // atomic write of the temp file into the directory fails with EACCES.
    await fs.chmod(dir, 0o555);
    try {
      await expect(store.set("token", "value")).rejects.toBeTruthy();
      // The optimistic in-memory mutation must not survive a failed persist.
      expect(await store.get("token")).toBeUndefined();
    } finally {
      // Restore write perms so afterEach can remove the tree.
      await fs.chmod(dir, 0o755);
    }
  });

  it("recovers on the same instance after a corrupt file is repaired", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ broken", "utf-8");
    await expect(store.get("token")).rejects.toThrow(/not valid JSON/);

    // External repair — the same store instance must not stay poisoned.
    await fs.writeFile(filePath, JSON.stringify({ token: "fixed" }), "utf-8");
    expect(await store.get<string>("token")).toBe("fixed");
  });

  it("does not diverge from disk when the caller mutates a stored object", async () => {
    const { store } = storeAt("acme.plugin.json");
    const value = { a: 1 };
    await store.set("config", value);
    value.a = 2;
    expect(await store.get<{ a: number }>("config")).toEqual({ a: 1 });
  });

  it.each([NaN, Infinity, -Infinity])(
    "caches a top-level %s as the null it persists as",
    async (value) => {
      const { store, filePath } = storeAt("acme.plugin.json");
      expect(await store.set("count", value)).toBe(true);
      expect(await store.get("count")).toBeNull();
      expect(JSON.parse(await fs.readFile(filePath, "utf-8")).count).toBeNull();
      expect(await new PluginSettingsStore(filePath).get("count")).toBeNull();
      expect(await store.set("count", null)).toBe(false);
    }
  );

  const idempotentIt = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;
  idempotentIt("treats an equal-value set as a no-op, even when the dir is read-only", async () => {
    const dir = path.join(tmpDir, "idem");
    await fs.mkdir(dir, { recursive: true });
    const store = new PluginSettingsStore(path.join(dir, "acme.plugin.json"));
    expect(await store.set("token", "v1")).toBe(true);
    await fs.chmod(dir, 0o555);
    try {
      // Equal value: must skip the write and not fail on the read-only dir.
      expect(await store.set("token", "v1")).toBe(false);
    } finally {
      await fs.chmod(dir, 0o755);
    }
  });

  it("serializes concurrent writes so all keys are persisted", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await Promise.all([store.set("a", 1), store.set("b", 2), store.set("c", 3), store.set("d", 4)]);
    const raw = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ a: 1, b: 2, c: 3, d: 4 });
  });

  describe("delete", () => {
    it("removes a stored key and reports the change", async () => {
      const { store, filePath } = storeAt("acme.plugin.json");
      await store.set("token", "sk-test");
      expect(await store.delete("token")).toBe(true);
      expect(await store.get("token")).toBeUndefined();
      const raw = await fs.readFile(filePath, "utf-8");
      expect(JSON.parse(raw)).toEqual({});
    });

    it("returns false when deleting an absent key", async () => {
      const { store } = storeAt("acme.plugin.json");
      expect(await store.delete("missing")).toBe(false);
    });

    it("leaves sibling keys intact", async () => {
      const { store } = storeAt("acme.plugin.json");
      await store.set("a", 1);
      await store.set("b", 2);
      expect(await store.delete("a")).toBe(true);
      expect(await store.get("a")).toBeUndefined();
      expect(await store.get<number>("b")).toBe(2);
    });

    it("persists the deletion across instances", async () => {
      const { store, filePath } = storeAt("acme.plugin.json");
      await store.set("token", "sk-test");
      await store.delete("token");
      const reopened = new PluginSettingsStore(filePath);
      expect(await reopened.get("token")).toBeUndefined();
    });

    const rollbackDeleteIt =
      process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;
    rollbackDeleteIt("rolls back the in-memory delete when the write fails", async () => {
      const dir = path.join(tmpDir, "ro-del");
      await fs.mkdir(dir, { recursive: true });
      const store = new PluginSettingsStore(path.join(dir, "acme.plugin.json"));
      await store.set("token", "value");
      await fs.chmod(dir, 0o555);
      try {
        await expect(store.delete("token")).rejects.toBeTruthy();
        // The optimistic in-memory delete must not survive a failed persist.
        expect(await store.get<string>("token")).toBe("value");
      } finally {
        await fs.chmod(dir, 0o755);
      }
    });
  });
});

describe("PluginSettingsStore after the file changes underneath it", () => {
  it("reads a rewrite that landed from outside, as a pull or branch switch would", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");

    await fs.writeFile(filePath, JSON.stringify({ channel: "x", cadence: 3 }));

    expect(await store.get("channel")).toBe("x");
    expect(await store.get("cadence")).toBe(3);
  });

  it("keeps the outside change when it writes next, instead of restoring its stale copy", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");
    await fs.writeFile(filePath, JSON.stringify({ channel: "x", cadence: 3 }));

    await store.set("reviewer", "sam");

    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual({
      channel: "x",
      cadence: 3,
      reviewer: "sam",
    });
  });

  it("gives every concurrent read the rewritten file, and writes on top of it", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");
    await fs.writeFile(filePath, JSON.stringify({ channel: "x" }));

    const reads = await Promise.all(Array.from({ length: 20 }, () => store.get("channel")));
    expect(new Set(reads)).toEqual(new Set(["x"]));

    await store.set("reviewer", "sam");
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual({
      channel: "x",
      reviewer: "sam",
    });
  });

  it("makes a write wait for a reload already in flight rather than write over it", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");
    await fs.writeFile(filePath, JSON.stringify({ channel: "x" }));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realReadFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, "readFile").mockImplementationOnce(async (...args) => {
      await gate;
      return realReadFile(...(args as Parameters<typeof fs.readFile>));
    });
    try {
      const read = store.get("channel");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const write = store.set("reviewer", "sam");
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      expect(await read).toBe("x");
      await write;
    } finally {
      spy.mockRestore();
    }

    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual({
      channel: "x",
      reviewer: "sam",
    });
  });

  it("doesn't lend its values the identity of a file replaced right after its own write", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");

    const realStat = fs.stat.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      // First stat: the pre-write freshness check. Second: the post-write one —
      // a checkout lands just before it.
      if (++calls === 2) await fs.writeFile(filePath, JSON.stringify({ channel: "x" }));
      return realStat(...(args as Parameters<typeof fs.stat>));
    });
    try {
      await store.set("reviewer", "sam");
    } finally {
      spy.mockRestore();
    }

    expect(await store.get("channel")).toBe("x");
    expect(await store.get("reviewer")).toBeUndefined();
  });

  it("sees the file deleted and recreated", async () => {
    const { store, filePath } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");
    await fs.rm(filePath);
    expect(await store.get("channel")).toBeUndefined();

    await fs.writeFile(filePath, JSON.stringify({ channel: "news" }));
    expect(await store.get("channel")).toBe("news");
  });

  it("answers a read racing its own write with the value being written", async () => {
    const { store } = storeAt("acme.plugin.json");
    await store.set("channel", "blog");

    const write = store.set("channel", "x");
    const reads = await Promise.all([store.get("channel"), store.get("channel")]);
    await write;

    for (const value of reads) expect(["blog", "x"]).toContain(value);
    expect(await store.get("channel")).toBe("x");
  });
});

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

  // Electron asks for the keychain once per run, so a retry can't get past a
  // dismissed prompt; the refusal says what will.
  // The exact words are the platform's (keyring or Keychain); secretCipher's
  // tests pin each.
  it("refuses a write the session's locked keychain can't take, saying a restart is the way", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    const cipher = fakeCipher(false);
    cipher.tier = () => "locked";
    const store = new PluginSettingsStore(filePath, cipher);

    await expect(store.set("token", "sk-1", { secret: true })).rejects.toThrow(
      /this session, so the secret "token" wasn't saved — restart Daintree to /
    );
    await expect(fs.access(filePath)).rejects.toThrow();
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

// Uninstalling with "delete settings" drops the plugin's stores, but a write one
// queued can still be waiting on the keychain when the file is deleted.
describe("wiping a settings file", () => {
  /** A cipher whose next encrypt waits until released. */
  function heldCipher() {
    const cipher = fakeCipher(true);
    const encrypt = cipher.encrypt.bind(cipher);
    const reached = deferred();
    const release = deferred();
    cipher.encrypt = async (plaintext) => {
      reached.resolve();
      await release.promise;
      return encrypt(plaintext);
    };
    return { cipher, reached, release };
  }

  it("drops a secret write still waiting on the keychain instead of recreating the file", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    await fs.writeFile(filePath, JSON.stringify({ endpoint: "https://x" }), "utf-8");
    const { cipher, reached, release } = heldCipher();
    const store = new PluginSettingsStore(filePath, cipher);

    const write = store.set("token", "sk-1", { secret: true });
    await reached.promise;
    const wipe = wipeSettingsFile(filePath);
    release.resolve();

    await expect(write).rejects.toThrow(/settings were deleted before this change landed/);
    await wipe;
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("drops a background re-encrypt a dropped store queued before the wipe", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    await fs.writeFile(filePath, JSON.stringify({ token: legacyEnvelope("sk-old") }), "utf-8");
    const { cipher, reached, release } = heldCipher();
    cipher.stale.add(seal("sk-old"));
    const store = new PluginSettingsStore(filePath, cipher);

    expect(await store.get<string>("token", { secret: true })).toBe("sk-old");
    await reached.promise;
    const wipe = wipeSettingsFile(filePath);
    release.resolve();
    await wipe;

    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("lets settings saved after the wipe land, from the same store or a new one", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    const old = new PluginSettingsStore(filePath, fakeCipher(true));
    await old.set("token", "sk-old", { secret: true });

    await wipeSettingsFile(filePath);
    await expect(fs.access(filePath)).rejects.toThrow();

    const reinstalled = new PluginSettingsStore(filePath, fakeCipher(true));
    expect(await reinstalled.set("token", "sk-new", { secret: true })).toBe(true);
    expect(await reinstalled.get<string>("token", { secret: true })).toBe("sk-new");
    expect(await old.set("endpoint", "https://x")).toBe(true);
    expect(await readRaw(filePath)).toMatchObject({ endpoint: "https://x" });
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

  it("queues a second store's write behind one over the same file still waiting on the keychain", async () => {
    const filePath = path.join(tmpDir, "acme.plugin.json");
    const slow = fakeCipher(true);
    const encrypt = slow.encrypt.bind(slow);
    const reached = deferred();
    const release = deferred();
    slow.encrypt = async (plaintext) => {
      reached.resolve();
      await release.promise;
      return encrypt(plaintext);
    };
    const replaced = new PluginSettingsStore(filePath, slow);
    const replacement = new PluginSettingsStore(filePath, fakeCipher(true));

    const older = replaced.set("token", "sk-old", { secret: true });
    await reached.promise;
    const newer = replacement.set("token", "sk-new", { secret: true });
    const raced = await Promise.race([
      newer.then(() => "saved"),
      new Promise((resolve) => setTimeout(() => resolve("queued"), 100)),
    ]);
    expect(raced).toBe("queued");
    release.resolve();

    expect(await older).toBe(true);
    expect(await newer).toBe(true);
    expect(await replacement.get<string>("token", { secret: true })).toBe("sk-new");
    expect((await readRaw(filePath)).token).toMatchObject({ cipher: seal("sk-new") });
  });

  it.each([false, true])(
    "drops a background re-encrypt when the file changes while the keychain encrypts (same timestamp: %s)",
    async (sameTimestamp) => {
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
      const originalStat = fs.stat.bind(fs);
      const before = await fs.stat(filePath, { bigint: true });
      const stat = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        const current = await originalStat(...(args as Parameters<typeof fs.stat>));
        // Linux can give fast in-place rewrites the same timestamp.
        if (sameTimestamp && args[0] === filePath) {
          Object.assign(current, { mtimeNs: before.mtimeNs });
        }
        return current;
      });
      try {
        expect(await store.get<string>("token", { secret: true })).toBe("sk-old");
        await reached.promise;
        await seed(filePath, { token: legacyEnvelope("sk-other") });
        const after = await originalStat(filePath, { bigint: true });
        expect(after.ino).toBe(before.ino);
        expect(after.size).toBe(before.size);
        release.resolve();
        await writesSettled(store);

        expect((await readRaw(filePath)).token).toEqual(legacyEnvelope("sk-other"));
      } finally {
        release.resolve();
        await writesSettled(store);
        stat.mockRestore();
      }
    }
  );

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
