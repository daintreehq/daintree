import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { MemoryKeyStore, claimRelay, type StoredIdentity } from "@daintreehq/decisions-client";
import { encryptRecoveryBundle } from "@daintreehq/decisions-crypto";
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  parseAuthHeader,
} from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({ app: {}, safeStorage: {}, net: {} }));

import { DecisionsKeyStoreError, type KeyStorageCheck } from "../keyStore.js";
import type { RelayFetch } from "../relayCheck.js";
import {
  claimDecisionsRelay,
  restoreDecisionsIdentity,
  type SetupKeyStore,
} from "../relayIdentity.js";

const ORIGIN = "https://decisions.example.workers.dev";
const OTHER_ORIGIN = "https://other.example.workers.dev";
const SECRET = "claim-secret-0123456789abcdef";
const PASSPHRASE = "correct horse battery staple";

const RELAY_VERSION = (
  JSON.parse(
    readFileSync(
      createRequire(import.meta.url).resolve("@daintreehq/decisions-protocol/package.json"),
      "utf8"
    )
  ) as { version: string }
).version;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function relayError(code: string, status: number): Response {
  return json({ code, message: code.replace(/_/g, " ") }, status);
}

type Intercept = (
  url: string,
  init: RequestInit,
  answer: () => Promise<Response>
) => Promise<Response>;

/**
 * A relay answering the routes setup uses, as the Worker does: the claim
 * checks already-claimed before the secret, and signed reads answer only
 * the device that registered.
 */
function fakeRelay(options: { claimConfigured?: boolean } = {}) {
  const state = {
    secret: SECRET,
    claimConfigured: options.claimConfigured ?? true,
    owner: null as null | { installationId: string; cert: Record<string, unknown> },
    revoked: false,
    claimBodies: [] as Array<Record<string, unknown>>,
    intercept: {} as Record<string, Intercept>,
  };
  const calls: Array<{ method: string; path: string; init: RequestInit }> = [];
  const route = async (url: string, init: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    if (pathname === "/health") return json({ ok: true });
    if (pathname === "/api/v1/info") {
      return json({
        name: "daintree-decisions",
        protocol_min: MIN_PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        worker_version: RELAY_VERSION,
        claimed: state.owner !== null,
        claim_configured: state.claimConfigured,
        voice: { xai: false, anthropic: false, openai: false },
      });
    }
    if (pathname === "/api/v1/setup/claim" && method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.claimBodies.push(body);
      if (state.owner) return relayError("already_claimed", 409);
      if (!state.claimConfigured) return relayError("not_configured", 503);
      if (body.claim_secret !== state.secret) return relayError("not_authenticated", 401);
      state.owner = {
        installationId: body.installation_id as string,
        cert: body.cert as Record<string, unknown>,
      };
      return json(
        {
          installation_id: body.installation_id,
          vapid_public_key: "vapid-public-key",
          server_time: new Date().toISOString(),
        },
        201
      );
    }
    if (pathname === "/api/v1/devices") {
      const auth = parseAuthHeader(new Headers(init.headers).get("authorization") ?? "");
      const owner = state.owner;
      if (!owner || !auth || auth.deviceId !== owner.cert.device_id) {
        return relayError("not_authenticated", 401);
      }
      const now = new Date().toISOString();
      return json({
        key_epoch: 1,
        owner_device_id: owner.cert.device_id,
        devices: [
          {
            device_id: owner.cert.device_id,
            role: "owner-desktop",
            label: owner.cert.label,
            created_at: now,
            revoked_at: state.revoked ? now : null,
            last_seen_at: null,
            last_ack_seq: 0,
            cert: owner.cert,
            push_enabled: false,
          },
        ],
      });
    }
    if (pathname === "/api/v1/push/config") return json({ vapid_public_key: "vapid-public-key" });
    return new Response("not found", { status: 404 });
  };
  const fetchImpl = vi.fn<RelayFetch>(async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method ?? "GET", path: pathname, init });
    const intercept = state.intercept[pathname];
    return intercept ? intercept(url, init, () => route(url, init)) : route(url, init);
  });
  return { state, fetchImpl, calls };
}

/** The sealed key store's contract, in memory. */
function memoryKeys(options: { check?: KeyStorageCheck; loadError?: Error } = {}) {
  let value: StoredIdentity | null = null;
  const keys = {
    check: vi.fn(async (): Promise<KeyStorageCheck> => options.check ?? { kind: "keychain" }),
    confirmWeakStorage: vi.fn(),
    load: vi.fn(async () => {
      if (options.loadError) throw options.loadError;
      return value ? structuredClone(value) : null;
    }),
    save: vi.fn(async (identity: StoredIdentity) => {
      value = structuredClone(identity);
    }),
    clear: vi.fn(async () => {
      value = null;
    }),
  } satisfies SetupKeyStore;
  return {
    keys,
    get stored() {
      return value;
    },
    set stored(next: StoredIdentity | null) {
      value = next;
    },
  };
}

/** An owner identity for `relay`, claimed through the library as the CLI would. */
async function claimedElsewhere(relay: ReturnType<typeof fakeRelay>): Promise<StoredIdentity> {
  const store = new MemoryKeyStore();
  await claimRelay({
    origin: ORIGIN,
    claimSecret: SECRET,
    store,
    fetch: relay.fetchImpl as unknown as typeof fetch,
  });
  return (await store.load())!;
}

function kitFor(identity: unknown, passphrase = PASSPHRASE): Promise<string> {
  return encryptRecoveryBundle(
    { kind: "decisions-recovery-kit", identity },
    passphrase,
    100_000
  ).then((file) => JSON.stringify(file));
}

function networkError(message: string): never {
  throw new TypeError(message);
}

describe("claimDecisionsRelay", () => {
  it("claims an unclaimed relay and seals the owner identity, without the secret", async () => {
    const relay = fakeRelay();
    const memory = memoryKeys();

    const outcome = await claimDecisionsRelay(
      { url: "decisions.example.workers.dev/setup", claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      identity: expect.objectContaining({
        relayOrigin: ORIGIN,
        installationId: relay.state.owner!.installationId,
        label: "Daintree",
      }),
    });
    expect(memory.stored).not.toBeNull();
    expect(memory.stored!.claimed).toBeUndefined();
    expect(memory.stored!.config.deviceId).toBe(relay.state.owner!.cert.device_id);
    // Staged before the claim was sent, then saved once the relay confirmed it.
    expect(memory.keys.save).toHaveBeenCalledTimes(2);
    expect(memory.keys.save.mock.calls[0]![0].claimed).toBe(false);
    expect(JSON.stringify(memory.stored)).not.toContain(SECRET);
    expect(relay.state.claimBodies).toEqual([expect.objectContaining({ claim_secret: SECRET })]);
  });

  it("sends every request held to the relay's origin, with no redirect, cookie or cache", async () => {
    const relay = fakeRelay();
    await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memoryKeys().keys, fetchImpl: relay.fetchImpl }
    );

    const claim = relay.calls.find((call) => call.path === "/api/v1/setup/claim")!;
    expect(claim.init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    expect(claim.init.signal).toBeInstanceOf(AbortSignal);
    expect(relay.fetchImpl.mock.calls.every(([url]) => url.startsWith(`${ORIGIN}/`))).toBe(true);
  });

  it("reports a wrong secret and removes the keys it staged for it", async () => {
    const relay = fakeRelay();
    const memory = memoryKeys();

    const outcome = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: "not-the-claim-secret-at-all" },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "refused", origin: ORIGIN, reason: "wrong-secret", kept: false },
    });
    expect(memory.stored).toBeNull();
    expect(relay.state.owner).toBeNull();
  });

  it("keeps an earlier attempt's keys when the relay refuses this one", async () => {
    const relay = fakeRelay();
    const memory = memoryKeys();
    relay.state.intercept["/api/v1/setup/claim"] = () => networkError("net::ERR_CONNECTION_RESET");
    await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );
    const staged = memory.stored;
    expect(staged?.claimed).toBe(false);

    delete relay.state.intercept["/api/v1/setup/claim"];
    const outcome = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: "not-the-claim-secret-at-all" },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "refused", origin: ORIGIN, reason: "wrong-secret", kept: true },
    });
    expect(memory.stored).toEqual(staged);
  });

  it("stops at the unsigned check when the relay is already claimed, staging nothing", async () => {
    const relay = fakeRelay();
    await claimedElsewhere(relay);
    const memory = memoryKeys();
    relay.state.claimBodies = [];

    const outcome = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "relay", check: expect.objectContaining({ result: "claimed" }) },
    });
    expect(memory.keys.save).not.toHaveBeenCalled();
    expect(relay.state.claimBodies).toEqual([]);
  });

  it("stops at the unsigned check when the relay has no claim secret set", async () => {
    const relay = fakeRelay({ claimConfigured: false });
    const memory = memoryKeys();

    const outcome = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: {
        result: "relay",
        check: expect.objectContaining({ result: "claim-not-configured" }),
      },
    });
    expect(memory.keys.save).not.toHaveBeenCalled();
  });

  it("reports a relay claimed by someone else between the check and the claim, keeping nothing", async () => {
    const relay = fakeRelay();
    const memory = memoryKeys();
    relay.state.intercept["/api/v1/setup/claim"] = (_url, _init, answer) => {
      relay.state.owner = {
        installationId: "inst_someone_else",
        cert: { device_id: "dev_someone_else" },
      };
      return answer();
    };

    const outcome = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "refused", origin: ORIGIN, reason: "already-claimed", kept: false },
    });
    expect(memory.stored).toBeNull();
  });

  it("keeps the keys when the claim's answer is lost, and finishes with them next time", async () => {
    const relay = fakeRelay();
    const memory = memoryKeys();
    relay.state.intercept["/api/v1/setup/claim"] = async (_url, _init, answer) => {
      await answer();
      return networkError("net::ERR_CONNECTION_RESET");
    };

    const lost = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );
    expect(lost).toEqual({
      failure: { result: "unreachable", origin: ORIGIN, reason: "network", kept: true },
    });
    expect(memory.stored?.claimed).toBe(false);
    const stagedDevice = memory.stored!.config.deviceId;
    expect(relay.state.owner?.cert.device_id).toBe(stagedDevice);

    delete relay.state.intercept["/api/v1/setup/claim"];
    // The relay now reads as claimed, but by this computer's own unfinished claim.
    const finished = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(finished).toEqual({
      identity: expect.objectContaining({ relayOrigin: ORIGIN, deviceId: stagedDevice }),
    });
    expect(memory.stored?.claimed).toBeUndefined();
  });

  it("removes the keys when the claim never left this computer", async () => {
    const relay = fakeRelay();
    const memory = memoryKeys();
    relay.state.intercept["/api/v1/setup/claim"] = () => networkError("net::ERR_NAME_NOT_RESOLVED");

    const outcome = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "unreachable", origin: ORIGIN, reason: "dns", kept: false },
    });
    expect(memory.stored).toBeNull();
  });

  it("keeps the keys when the relay answers the claim with a server error", async () => {
    const relay = fakeRelay();
    const memory = memoryKeys();
    relay.state.intercept["/api/v1/setup/claim"] = async () => relayError("internal_error", 500);

    const outcome = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "unreachable", origin: ORIGIN, reason: "server-error", kept: true },
    });
    expect(memory.stored?.claimed).toBe(false);
  });

  it("reports a locked keychain before sending anything", async () => {
    const relay = fakeRelay();
    const memory = memoryKeys({ check: { kind: "locked", reason: "The keychain is locked" } });

    const outcome = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "key-storage", kind: "locked", reason: "The keychain is locked" },
    });
    expect(relay.fetchImpl).not.toHaveBeenCalled();
    expect(memory.keys.save).not.toHaveBeenCalled();
  });

  it("reports keys that can't be read, leaving them as they are", async () => {
    const relay = fakeRelay();
    const memory = memoryKeys({
      loadError: new DecisionsKeyStoreError("unreadable", "The Decisions key file is damaged"),
    });

    const outcome = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: {
        result: "key-storage",
        kind: "unreadable",
        reason: "The Decisions key file is damaged",
      },
    });
    expect(memory.keys.clear).not.toHaveBeenCalled();
    expect(relay.fetchImpl).not.toHaveBeenCalled();
  });

  it("asks before using Linux's fixed-key storage, and uses it once accepted", async () => {
    const relay = fakeRelay();
    const memory = memoryKeys({ check: { kind: "weak", reason: "No keyring is available" } });

    const refused = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );
    expect(refused).toEqual({
      failure: {
        result: "key-storage",
        kind: "weak-storage-unconfirmed",
        reason: "No keyring is available",
      },
    });
    expect(relay.fetchImpl).not.toHaveBeenCalled();

    const accepted = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET, acceptWeakStorage: true },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );
    expect(memory.keys.confirmWeakStorage).toHaveBeenCalledOnce();
    expect(accepted).toEqual({ identity: expect.objectContaining({ relayOrigin: ORIGIN }) });
  });

  it("takes up a sealed identity for the same relay without asking the relay", async () => {
    const relay = fakeRelay();
    const memory = memoryKeys();
    memory.stored = await claimedElsewhere(relay);
    relay.fetchImpl.mockClear();

    const outcome = await claimDecisionsRelay(
      { url: ORIGIN, claimSecret: SECRET },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({ identity: memory.stored!.config });
    expect(relay.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to replace keys for another relay or another relay's unfinished claim", async () => {
    const relay = fakeRelay();
    const elsewhere = await claimedElsewhere(fakeRelay());
    const complete = memoryKeys();
    complete.stored = { ...elsewhere, config: { ...elsewhere.config, relayOrigin: OTHER_ORIGIN } };
    const unfinished = memoryKeys();
    unfinished.stored = { ...complete.stored, claimed: false };
    relay.fetchImpl.mockClear();

    await expect(
      claimDecisionsRelay(
        { url: ORIGIN, claimSecret: SECRET },
        { keys: complete.keys, fetchImpl: relay.fetchImpl }
      )
    ).resolves.toEqual({
      failure: { result: "conflict", origin: OTHER_ORIGIN, unfinished: false },
    });
    await expect(
      claimDecisionsRelay(
        { url: ORIGIN, claimSecret: SECRET },
        { keys: unfinished.keys, fetchImpl: relay.fetchImpl }
      )
    ).resolves.toEqual({
      failure: { result: "conflict", origin: OTHER_ORIGIN, unfinished: true },
    });
    expect(relay.fetchImpl).not.toHaveBeenCalled();
    expect(complete.keys.save).not.toHaveBeenCalled();
    expect(unfinished.keys.clear).not.toHaveBeenCalled();
  });

  it("refuses an address that isn't https without sending anything", async () => {
    const relay = fakeRelay();
    const outcome = await claimDecisionsRelay(
      { url: "http://decisions.example.workers.dev", claimSecret: SECRET },
      { keys: memoryKeys().keys, fetchImpl: relay.fetchImpl }
    );
    expect(outcome).toEqual({
      failure: { result: "relay", check: { result: "invalid-url", reason: "not-https" } },
    });
    expect(relay.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("restoreDecisionsIdentity", () => {
  async function setup() {
    const relay = fakeRelay();
    const identity = await claimedElsewhere(relay);
    relay.fetchImpl.mockClear();
    relay.calls.length = 0;
    return { relay, identity, kit: await kitFor(identity) };
  }

  it("restores a kit the relay recognises as its owner, and seals it", async () => {
    const { relay, identity, kit } = await setup();
    const memory = memoryKeys();

    const outcome = await restoreDecisionsIdentity(
      { url: ORIGIN, kit, passphrase: PASSPHRASE },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({ identity: identity.config });
    expect(memory.stored).toEqual(identity);
    expect(relay.calls.map((call) => call.path)).toEqual([
      "/health",
      "/api/v1/info",
      "/api/v1/devices",
    ]);
  });

  it("reports a passphrase that doesn't open the kit, sending and saving nothing", async () => {
    const { relay, kit } = await setup();
    const memory = memoryKeys();

    const outcome = await restoreDecisionsIdentity(
      { url: ORIGIN, kit, passphrase: "the wrong passphrase" },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "kit-refused", origin: ORIGIN, reason: "wrong-passphrase" },
    });
    expect(relay.fetchImpl).not.toHaveBeenCalled();
    expect(memory.keys.save).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "a recovery kit, honest"],
    ["another file", JSON.stringify({ name: "package" })],
    [
      "a key derivation too costly to run",
      JSON.stringify({
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 2_000_000_000,
        salt: "AAAA",
        nonce: "AAAA",
        ciphertext: "AAAA",
      }),
    ],
  ])("refuses %s as a recovery kit", async (_name, kit) => {
    const { relay } = await setup();
    const memory = memoryKeys();

    const outcome = await restoreDecisionsIdentity(
      { url: ORIGIN, kit, passphrase: PASSPHRASE },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "kit-refused", origin: ORIGIN, reason: "not-a-kit" },
    });
    expect(relay.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a kit for another relay", async () => {
    const { relay, identity } = await setup();
    const kit = await kitFor({
      ...identity,
      config: { ...identity.config, relayOrigin: OTHER_ORIGIN },
    });

    const outcome = await restoreDecisionsIdentity(
      { url: ORIGIN, kit, passphrase: PASSPHRASE },
      { keys: memoryKeys().keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "kit-refused", origin: ORIGIN, reason: "another-relay" },
    });
    expect(relay.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a Host's identity and an unfinished claim's", async () => {
    const { relay, identity } = await setup();
    const host = await kitFor({ ...identity, role: "desktop-host" });
    const unfinished = await kitFor({ ...identity, claimed: false });

    await expect(
      restoreDecisionsIdentity(
        { url: ORIGIN, kit: host, passphrase: PASSPHRASE },
        { keys: memoryKeys().keys, fetchImpl: relay.fetchImpl }
      )
    ).resolves.toEqual({
      failure: { result: "kit-refused", origin: ORIGIN, reason: "not-owner" },
    });
    await expect(
      restoreDecisionsIdentity(
        { url: ORIGIN, kit: unfinished, passphrase: PASSPHRASE },
        { keys: memoryKeys().keys, fetchImpl: relay.fetchImpl }
      )
    ).resolves.toEqual({
      failure: { result: "kit-refused", origin: ORIGIN, reason: "unfinished" },
    });
  });

  it("refuses an identity the relay doesn't accept, saving nothing", async () => {
    const { identity } = await setup();
    // The same address, now claimed by someone else.
    const relay = fakeRelay();
    await claimedElsewhere(relay);
    const memory = memoryKeys();

    const outcome = await restoreDecisionsIdentity(
      { url: ORIGIN, kit: await kitFor(identity), passphrase: PASSPHRASE },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "kit-refused", origin: ORIGIN, reason: "not-recognised" },
    });
    expect(memory.keys.save).not.toHaveBeenCalled();
  });

  it("refuses an identity the relay lists as revoked", async () => {
    const { relay, kit } = await setup();
    relay.state.revoked = true;
    const memory = memoryKeys();

    const outcome = await restoreDecisionsIdentity(
      { url: ORIGIN, kit, passphrase: PASSPHRASE },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "kit-refused", origin: ORIGIN, reason: "not-recognised" },
    });
    expect(memory.keys.save).not.toHaveBeenCalled();
  });

  it("goes no further than the unsigned check for a relay that isn't claimed", async () => {
    const { identity } = await setup();
    const relay = fakeRelay();

    const outcome = await restoreDecisionsIdentity(
      { url: ORIGIN, kit: await kitFor(identity), passphrase: PASSPHRASE },
      { keys: memoryKeys().keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "relay", check: expect.objectContaining({ result: "unclaimed" }) },
    });
    expect(relay.calls.map((call) => call.path)).not.toContain("/api/v1/devices");
  });

  it("reports a relay that stops answering at the signed check, saving nothing", async () => {
    const { relay, kit } = await setup();
    relay.state.intercept["/api/v1/devices"] = () => networkError("net::ERR_CONNECTION_REFUSED");
    const memory = memoryKeys();

    const outcome = await restoreDecisionsIdentity(
      { url: ORIGIN, kit, passphrase: PASSPHRASE },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "unreachable", origin: ORIGIN, reason: "refused", kept: false },
    });
    expect(memory.keys.save).not.toHaveBeenCalled();
  });

  it("reports an unavailable keychain before asking the relay anything", async () => {
    const { relay, kit } = await setup();
    const memory = memoryKeys({ check: { kind: "unavailable", reason: "No secure storage" } });

    const outcome = await restoreDecisionsIdentity(
      { url: ORIGIN, kit, passphrase: PASSPHRASE },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({
      failure: { result: "key-storage", kind: "unavailable", reason: "No secure storage" },
    });
    expect(relay.fetchImpl).not.toHaveBeenCalled();
  });

  it("takes up the same identity already sealed here without replacing its keys", async () => {
    const { relay, identity, kit } = await setup();
    const memory = memoryKeys();
    // Sealed here with a newer epoch than the kit holds.
    memory.stored = { ...identity, currentEpoch: 2, epochs: [...identity.epochs] };

    const outcome = await restoreDecisionsIdentity(
      { url: ORIGIN, kit, passphrase: PASSPHRASE },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({ identity: identity.config });
    expect(memory.keys.save).not.toHaveBeenCalled();
    expect(memory.stored?.currentEpoch).toBe(2);
  });

  it("refuses to replace another identity sealed here", async () => {
    const { relay, kit } = await setup();
    const memory = memoryKeys();
    memory.stored = await claimedElsewhere(fakeRelay());

    const outcome = await restoreDecisionsIdentity(
      { url: ORIGIN, kit, passphrase: PASSPHRASE },
      { keys: memory.keys, fetchImpl: relay.fetchImpl }
    );

    expect(outcome).toEqual({ failure: { result: "conflict", origin: ORIGIN, unfinished: false } });
    expect(memory.keys.save).not.toHaveBeenCalled();
    expect(relay.fetchImpl).not.toHaveBeenCalled();
  });
});
