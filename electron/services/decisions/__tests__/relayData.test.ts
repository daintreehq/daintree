import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredIdentity } from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  newId,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url, parseAuthHeader } from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({ app: {}, safeStorage: {}, net: {} }));

import { DecisionsKeyStoreError } from "../keyStore.js";
import type { RelayFetch } from "../relayCheck.js";
import { deleteDecisionsRelayData } from "../relayData.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";
import type { DecisionsSettings } from "../../../../shared/types/decisions.js";

const ORIGIN = "https://decisions.example.workers.dev";
const DELETE_PATH = "/api/v1/admin/delete-data";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function ownerIdentity(overrides: Partial<StoredIdentity> = {}): Promise<StoredIdentity> {
  return {
    v: 1,
    config: { relayOrigin: ORIGIN, installationId: newId(), deviceId: newId(), label: "Daintree" },
    keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
    ...overrides,
  };
}

function settingsFor(stored: StoredIdentity): DecisionsSettings {
  return {
    ...defaultDecisionsSettings(),
    enabled: true,
    relayOrigin: ORIGIN,
    installationId: stored.config.installationId,
    deviceId: stored.config.deviceId,
    hostId: "host_12345678",
  };
}

/**
 * The relay's delete route as the Worker answers it: only for its owner's
 * signed request, with the body the protocol fixes. `answer` replaces what it
 * says once it has deleted.
 */
function fakeRelay(ownerDeviceId: string) {
  const state = {
    deleted: [] as string[],
    answer: null as null | ((init: RequestInit) => Promise<Response>),
  };
  const fetchImpl = vi.fn<RelayFetch>(async (url, init) => {
    if (new URL(url).pathname !== DELETE_PATH || init.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const auth = parseAuthHeader(new Headers(init.headers).get("authorization") ?? "");
    if (!auth || auth.deviceId !== ownerDeviceId) {
      return json({ code: "not_authenticated", message: "not authenticated" }, 401);
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (body.protocol_version !== 1 || body.confirm !== "DELETE") {
      return json({ code: "validation_error", message: "bad body" }, 400);
    }
    state.deleted.push(String(body.scope));
    return state.answer ? state.answer(init) : json({ ok: true, scope: body.scope });
  });
  return { state, fetchImpl };
}

describe("deleteDecisionsRelayData", () => {
  let stored: StoredIdentity;
  let relay: ReturnType<typeof fakeRelay>;

  beforeEach(async () => {
    stored = await ownerIdentity();
    relay = fakeRelay(stored.config.deviceId);
  });

  function run(overrides: Partial<Parameters<typeof deleteDecisionsRelayData>[0]> = {}) {
    return deleteDecisionsRelayData({
      origin: ORIGIN,
      settings: settingsFor(stored),
      keys: { load: async () => stored },
      fetchImpl: relay.fetchImpl,
      ...overrides,
    });
  }

  it("deletes the stored content only, signed as the owner, once the relay says so", async () => {
    await expect(run()).resolves.toEqual({ result: "deleted", origin: ORIGIN });

    expect(relay.state.deleted).toEqual(["questions"]);
    expect(relay.fetchImpl).toHaveBeenCalledOnce();
  });

  it("takes the confirmed relay however it was written, as long as it's the one set up", async () => {
    await expect(run({ origin: `${ORIGIN}/` })).resolves.toEqual({
      result: "deleted",
      origin: ORIGIN,
    });
  });

  it("sends nothing when the relay set up here isn't the one confirmed", async () => {
    await expect(run({ origin: "https://other.example.workers.dev" })).resolves.toEqual({
      result: "changed",
      origin: ORIGIN,
    });
    await expect(
      run({ settings: { ...settingsFor(stored), relayOrigin: null } })
    ).resolves.toEqual({ result: "changed", origin: null });

    expect(relay.fetchImpl).not.toHaveBeenCalled();
  });

  it("sends nothing without this computer's finished owner identity for that relay", async () => {
    const unfinished = { ...stored, claimed: false };
    const host = { ...stored, role: "desktop-host" as const };
    const elsewhere = { ...stored, config: { ...stored.config, relayOrigin: "https://x.dev" } };
    for (const keys of [null, unfinished, host, elsewhere]) {
      await expect(run({ keys: { load: async () => keys } })).resolves.toEqual({
        result: "no-identity",
        origin: ORIGIN,
      });
    }
    await expect(
      run({ settings: { ...settingsFor(stored), deviceId: "dev_another1" } })
    ).resolves.toEqual({ result: "no-identity", origin: ORIGIN });

    expect(relay.fetchImpl).not.toHaveBeenCalled();
  });

  it("reports keys that won't open as the key store's refusal, sending nothing", async () => {
    const timeout = new DecisionsKeyStoreError("timeout", "The keychain didn't answer");

    await expect(run({ keys: { load: () => Promise.reject(timeout) } })).resolves.toEqual({
      result: "key-storage",
      kind: "timeout",
      reason: "The keychain didn't answer",
    });
    expect(relay.fetchImpl).not.toHaveBeenCalled();
  });

  it("reports the relay's refusals by what they mean, asking once", async () => {
    const cases = [
      { status: 401, code: "not_authenticated", reason: "not-recognised" },
      { status: 403, code: "forbidden", reason: "not-recognised" },
      { status: 429, code: "rate_limited", reason: "rate-limited" },
      { status: 400, code: "validation_error", reason: "rejected" },
    ] as const;
    for (const { status, code, reason } of cases) {
      relay.fetchImpl.mockClear();
      relay.state.answer = async () => json({ code, message: code }, status);

      await expect(run()).resolves.toEqual({ result: "refused", origin: ORIGIN, reason, status });
      expect(relay.fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("can't confirm a deletion the relay answered with a server error, and doesn't ask again", async () => {
    relay.state.answer = async () => json({ code: "internal_error", message: "boom" }, 500);

    await expect(run()).resolves.toEqual({
      result: "unconfirmed",
      origin: ORIGIN,
      reason: "server-error",
    });
    expect(relay.fetchImpl).toHaveBeenCalledOnce();
  });

  it("can't confirm a success that isn't the relay's answer", async () => {
    for (const answer of [
      () => json({}),
      () => json({ ok: true, scope: "everything" }),
      () => new Response("<html>hello</html>", { status: 200 }),
    ]) {
      relay.state.answer = async () => answer();

      await expect(run()).resolves.toEqual({
        result: "unconfirmed",
        origin: ORIGIN,
        reason: "unexpected-answer",
      });
    }
  });

  it("can't confirm a deletion whose answer never came, though the relay may have done it", async () => {
    relay.state.answer = (init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation timed out.", "TimeoutError"))
        );
      });

    await expect(run({ timeoutMs: 50 })).resolves.toEqual({
      result: "unconfirmed",
      origin: ORIGIN,
      reason: "timeout",
    });
    expect(relay.state.deleted).toEqual(["questions"]);
  });

  it("says nothing was sent when the request never left this computer", async () => {
    const fetchImpl = vi.fn<RelayFetch>(async () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    });

    await expect(run({ fetchImpl })).resolves.toEqual({
      result: "not-sent",
      origin: ORIGIN,
      reason: "dns",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
