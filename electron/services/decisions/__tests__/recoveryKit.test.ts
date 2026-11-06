import { describe, expect, it, vi } from "vitest";
import {
  MemoryKeyStore,
  claimRelay,
  verifyRecoveryKit,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import {
  RECOVERY_KDF_ITERATIONS,
  decryptRecoveryBundle,
  encryptRecoveryBundle,
  generateEpochKeyBytes,
  type RecoveryBundleFile,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url } from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({ app: {}, safeStorage: {}, net: {} }));

import type { DecisionsSettings } from "../../../../shared/types/decisions.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";
import { DecisionsKeyStoreError } from "../keyStore.js";
import { checkRecoveryKit, makeRecoveryKit, recordedIdentity } from "../recoveryKit.js";

const ORIGIN = "https://decisions.example.workers.dev";
const PASSPHRASE = "correct horse battery staple";

/** An owner identity claimed through the library, against a relay that takes any claim. */
async function claimedIdentity(): Promise<StoredIdentity> {
  const store = new MemoryKeyStore();
  await claimRelay({
    origin: ORIGIN,
    claimSecret: "claim-secret-0123456789abcdef",
    store,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/v1/setup/claim") {
        const body = JSON.parse(String(init?.body)) as { installation_id: string };
        return new Response(
          JSON.stringify({
            installation_id: body.installation_id,
            vapid_public_key: "vapid-public-key",
            server_time: new Date().toISOString(),
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  });
  return (await store.load())!;
}

function settingsFor(identity: StoredIdentity): DecisionsSettings {
  return {
    ...defaultDecisionsSettings(),
    enabled: true,
    relayOrigin: ORIGIN,
    installationId: identity.config.installationId,
    deviceId: identity.config.deviceId,
  };
}

function keysHolding(identity: StoredIdentity | null, loadError?: Error) {
  return {
    load: vi.fn(async () => {
      if (loadError) throw loadError;
      return identity ? structuredClone(identity) : null;
    }),
  };
}

function kitFor(identity: unknown, passphrase = PASSPHRASE): Promise<string> {
  return encryptRecoveryBundle(
    { kind: "decisions-recovery-kit", identity },
    passphrase,
    100_000
  ).then((file) => JSON.stringify(file));
}

function withEpoch(identity: StoredIdentity, epoch: number, raw = generateEpochKeyBytes()) {
  return {
    ...identity,
    currentEpoch: epoch,
    epochs: [...identity.epochs, { epoch, raw: bytesToBase64Url(raw) }],
  };
}

describe("recordedIdentity", () => {
  it("is the relay and ids the setting records, and null until all three are there", () => {
    const settings = {
      ...defaultDecisionsSettings(),
      relayOrigin: ORIGIN,
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
    };
    expect(recordedIdentity(settings)).toEqual({
      relayOrigin: ORIGIN,
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
    });
    for (const field of ["relayOrigin", "installationId", "deviceId"] as const) {
      expect(recordedIdentity({ ...settings, [field]: null }), field).toBeNull();
    }
    expect(recordedIdentity(defaultDecisionsSettings())).toBeNull();
  });
});

describe("makeRecoveryKit", () => {
  it("locks the sealed identity in the library's kit format, which its own verifier accepts", async () => {
    const identity = await claimedIdentity();

    const made = await makeRecoveryKit(keysHolding(identity), settingsFor(identity), PASSPHRASE);

    if (!("text" in made)) throw new Error(`expected a kit, got ${JSON.stringify(made)}`);
    expect(made.recorded).toEqual({
      relayOrigin: ORIGIN,
      installationId: identity.config.installationId,
      deviceId: identity.config.deviceId,
    });
    const file = JSON.parse(made.text) as RecoveryBundleFile;
    expect(file.iterations).toBe(RECOVERY_KDF_ITERATIONS);
    expect(made.text).not.toContain(PASSPHRASE);
    expect(made.text).not.toContain(identity.keys.signing_private_pkcs8);
    await expect(verifyRecoveryKit(file, PASSPHRASE)).resolves.toMatchObject({
      ok: true,
      deviceId: identity.config.deviceId,
    });
    await expect(decryptRecoveryBundle(file, PASSPHRASE)).resolves.toEqual({
      kind: "decisions-recovery-kit",
      identity,
    });
  });

  it("refuses a passphrase shorter than the library allows", async () => {
    const identity = await claimedIdentity();

    await expect(
      makeRecoveryKit(keysHolding(identity), settingsFor(identity), "short phrase")
    ).resolves.toHaveProperty("text");
    await expect(
      makeRecoveryKit(keysHolding(identity), settingsFor(identity), "eleven char")
    ).rejects.toThrow(/at least 12/);
  });

  it("says no relay is set up, without asking the keychain", async () => {
    const keys = keysHolding(null);

    await expect(
      makeRecoveryKit(keys, { ...defaultDecisionsSettings(), enabled: true }, PASSPHRASE)
    ).resolves.toEqual({ failure: { result: "no-identity", reason: "not-set-up" } });
    expect(keys.load).not.toHaveBeenCalled();
  });

  it("says the keys are missing when none are sealed", async () => {
    const identity = await claimedIdentity();

    await expect(
      makeRecoveryKit(keysHolding(null), settingsFor(identity), PASSPHRASE)
    ).resolves.toEqual({ failure: { result: "no-identity", reason: "keys-missing" } });
  });

  it("refuses sealed keys that aren't the recorded relay's working, confirmed owner", async () => {
    const identity = await claimedIdentity();
    const other = await claimedIdentity();
    for (const [name, sealed] of [
      ["another identity", other],
      ["an unfinished claim", { ...identity, claimed: false }],
      ["a Remote Host's identity", { ...identity, role: "desktop-host" }],
      [
        "broken keys",
        {
          ...identity,
          keys: { ...identity.keys, signing_private_pkcs8: other.keys.signing_private_pkcs8 },
        },
      ],
    ] as const) {
      await expect(
        makeRecoveryKit(keysHolding(sealed as StoredIdentity), settingsFor(identity), PASSPHRASE),
        name
      ).resolves.toEqual({ failure: { result: "no-identity", reason: "keys-mismatch" } });
    }
  });

  it("reports a keychain that won't open the keys as key storage", async () => {
    const identity = await claimedIdentity();
    const locked = new DecisionsKeyStoreError("locked", "The keychain is locked");

    await expect(
      makeRecoveryKit(keysHolding(null, locked), settingsFor(identity), PASSPHRASE)
    ).resolves.toEqual({
      failure: { result: "key-storage", kind: "locked", reason: "The keychain is locked" },
    });
  });
});

describe("checkRecoveryKit", () => {
  it("verifies a kit holding this computer's identity and every key it has", async () => {
    const identity = await claimedIdentity();

    await expect(
      checkRecoveryKit(
        keysHolding(identity),
        settingsFor(identity),
        await kitFor(identity),
        PASSPHRASE
      )
    ).resolves.toEqual({
      verified: {
        relayOrigin: ORIGIN,
        installationId: identity.config.installationId,
        deviceId: identity.config.deviceId,
      },
    });
  });

  it("verifies a kit it made", async () => {
    const identity = await claimedIdentity();
    const keys = keysHolding(identity);
    const made = await makeRecoveryKit(keys, settingsFor(identity), PASSPHRASE);
    if (!("text" in made)) throw new Error("expected a kit");

    await expect(
      checkRecoveryKit(keys, settingsFor(identity), made.text, PASSPHRASE)
    ).resolves.toHaveProperty("verified");
  });

  it("refuses a kit the passphrase doesn't open, before asking the keychain", async () => {
    const identity = await claimedIdentity();
    const keys = keysHolding(identity);

    await expect(
      checkRecoveryKit(keys, settingsFor(identity), await kitFor(identity), "not the passphrase")
    ).resolves.toEqual({ failure: { result: "kit-refused", reason: "wrong-passphrase" } });
    expect(keys.load).not.toHaveBeenCalled();
  });

  it("refuses a file that isn't a kit, or one whose keys don't work", async () => {
    const identity = await claimedIdentity();
    const other = await claimedIdentity();
    const broken = {
      ...identity,
      keys: { ...identity.keys, exchange_private_pkcs8: other.keys.exchange_private_pkcs8 },
    };
    for (const text of [
      "not json",
      JSON.stringify({ v: 1 }),
      await encryptRecoveryBundle({ kind: "something-else", identity }, PASSPHRASE, 100_000).then(
        (file) => JSON.stringify(file)
      ),
      await kitFor(broken),
    ]) {
      await expect(
        checkRecoveryKit(keysHolding(identity), settingsFor(identity), text, PASSPHRASE)
      ).resolves.toEqual({ failure: { result: "kit-refused", reason: "not-a-kit" } });
    }
  });

  it("refuses another identity's kit, and an unfinished claim's of this one", async () => {
    const identity = await claimedIdentity();
    const other = await claimedIdentity();
    for (const kit of [other, { ...identity, claimed: false }]) {
      await expect(
        checkRecoveryKit(
          keysHolding(identity),
          settingsFor(identity),
          await kitFor(kit),
          PASSPHRASE
        )
      ).resolves.toEqual({ failure: { result: "kit-refused", reason: "another-identity" } });
    }
  });

  it("refuses a kit missing a key held here, or holding a different one for the same epoch", async () => {
    const identity = await claimedIdentity();
    const newer = withEpoch(identity, 2);
    const relabelled: StoredIdentity = {
      ...identity,
      epochs: identity.epochs.map((entry) => ({
        ...entry,
        raw: bytesToBase64Url(generateEpochKeyBytes()),
      })),
    };
    for (const [name, kit, held] of [
      ["lacks the current epoch's key", identity, newer],
      ["holds other bytes for the same epoch", relabelled, identity],
      // Every key, but an older current epoch: restoring it would write under the old one.
      ["is at an older current epoch", { ...newer, currentEpoch: 1 }, newer],
      [
        "lacks an earlier epoch's key",
        { ...newer, epochs: newer.epochs.filter(({ epoch }) => epoch === 2) },
        newer,
      ],
    ] as const) {
      await expect(
        checkRecoveryKit(keysHolding(held), settingsFor(identity), await kitFor(kit), PASSPHRASE),
        name
      ).resolves.toEqual({ failure: { result: "kit-refused", reason: "missing-epochs" } });
    }
  });

  it("verifies a kit that kept up with a newer epoch", async () => {
    const identity = await claimedIdentity();
    const newer = withEpoch(identity, 2);

    await expect(
      checkRecoveryKit(keysHolding(newer), settingsFor(identity), await kitFor(newer), PASSPHRASE)
    ).resolves.toHaveProperty("verified");
  });

  it("says why there is nothing to check against", async () => {
    const identity = await claimedIdentity();
    const kit = await kitFor(identity);

    await expect(
      checkRecoveryKit(keysHolding(null), settingsFor(identity), kit, PASSPHRASE)
    ).resolves.toEqual({ failure: { result: "no-identity", reason: "keys-missing" } });
    await expect(
      checkRecoveryKit(keysHolding(identity), defaultDecisionsSettings(), kit, PASSPHRASE)
    ).resolves.toEqual({ failure: { result: "no-identity", reason: "not-set-up" } });
  });
});
