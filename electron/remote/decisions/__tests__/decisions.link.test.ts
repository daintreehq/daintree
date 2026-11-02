// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("electron", () => ({ app: { getPath: () => "/nonexistent" }, safeStorage: {}, net: {} }));

import {
  decodeHostEnrollment,
  decodeHostRequest,
  enrollHost,
  importIdentity,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import type { DecisionsHostLink } from "../../../types/decisionsHosts.js";
import { HostEnrollments } from "../../../services/decisions/hostEnrollmentHost.js";
import type { LinkSession } from "../../link/session.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import { DecisionsHostsClient } from "../client.js";
import { installDecisionsHostWith, type DecisionsHostEnrollment } from "../host.js";
import { DECISIONS_LINK_METHOD_LOCALITY, DecisionsLinkMethod } from "../linkMethods.js";
import { makeOwner, memoryKeys } from "./ownerFixture.js";

const HOST = "studio-03";

let dir: string;
let pairs: Array<{ host: LinkSession; client: LinkSession }>;
let uninstalls: Array<() => void>;

async function pair() {
  const next = await openSessionPair(dir);
  pairs.push(next);
  return next;
}

/** A Host serving `session` with an enrollment over `keys`, loaded on its first CALL as in production. */
function serve(session: LinkSession, enrollment: DecisionsHostEnrollment) {
  const load = vi.fn(async () => enrollment);
  uninstalls.push(
    installDecisionsHostWith({ sessions: [{ session }], onSession: () => () => {} }, load)
  );
  return load;
}

function linkOver(session: LinkSession, hold = vi.fn(() => () => {})): DecisionsHostLink {
  const client = new DecisionsHostsClient({
    hosts: () => [{ hostId: HOST, name: HOST }],
    sessionFor: (hostId) => (hostId === HOST ? session : null),
    onSessionOpened: () => () => {},
    onHostsChanged: () => () => {},
    hold,
  });
  const link = client.linkFor(HOST);
  if (!link) throw new Error("no link");
  return link;
}

/** Every private half a stored identity holds. */
function privateParts(stored: StoredIdentity): string[] {
  return [
    stored.keys.signing_private_pkcs8,
    stored.keys.exchange_private_pkcs8,
    ...stored.epochs.map((epoch) => epoch.raw),
  ];
}

/** Runs one whole enrollment over `link`, the owner's half done with the real library. */
async function enrollOver(
  link: DecisionsHostLink,
  owner: Awaited<ReturnType<typeof makeOwner>>,
  options: { attempt?: string; replace?: string } = {}
) {
  const attempt = options.attempt ?? "attempt_0000000001";
  const requested = await link.request({
    attempt,
    label: HOST,
    ...(options.replace ? { replace: options.replace } : {}),
  });
  if (!requested.ok || requested.value.step !== "requested") {
    throw new Error(`request: ${JSON.stringify(requested)}`);
  }
  const { response } = await enrollHost(owner.client, requested.value.request);
  const accepted = await link.accept({ attempt, response });
  return { requested: requested.value, response, accepted };
}

beforeEach(async () => {
  dir = await makeTempDir();
  pairs = [];
  uninstalls = [];
});

afterEach(async () => {
  for (const uninstall of uninstalls) uninstall();
  for (const { host, client } of pairs) {
    host.close("test");
    client.close("test");
  }
  await removeTempDir(dir);
});

describe("enrolling a Remote Host as a Decisions device over its link", () => {
  it("is served by the Host alone", () => {
    expect(DECISIONS_LINK_METHOD_LOCALITY[DecisionsLinkMethod.ENROLL_HOST]).toBe("host");
  });

  it("enrolls end to end: the Host makes its keys, the owner signs, the Host seals what it was given", async () => {
    const { host, client } = await pair();
    const keys = memoryKeys();
    const load = serve(host, new HostEnrollments({ openKeys: keys.open }));
    const hold = vi.fn(() => () => {});
    const link = linkOver(client, hold);
    const owner = await makeOwner();

    // Nothing of Decisions loads on the Host until a Shell asks.
    expect(load).not.toHaveBeenCalled();
    expect(await link.status()).toEqual({ ok: true, value: { kind: "none" } });
    expect(load).toHaveBeenCalledTimes(1);

    const { requested, response, accepted } = await enrollOver(link, owner);
    expect(accepted).toEqual({
      ok: true,
      value: { step: "accepted", deviceId: decodeHostRequest(requested.request).device_id },
    });

    const saved = keys.current();
    expect(saved?.role).toBe("desktop-host");
    expect(saved?.config).toMatchObject({
      relayOrigin: owner.stored.config.relayOrigin,
      installationId: owner.installationId,
    });
    expect(saved?.host?.ownerCert.device_id).toBe(owner.deviceId);
    // What was saved imports as a working identity pinned to this owner.
    const identity = await importIdentity(saved!);
    expect(identity.owner.signingPub).toBe(owner.identity.signingPub);
    // The relay registered exactly the keys the Host made.
    expect(owner.registered).toHaveLength(1);
    expect(owner.registered[0].cert.signing_pub).toBe(saved!.keys.signing_public);
    expect(decodeHostEnrollment(response).cert.role).toBe("desktop-host");

    // Nothing private crossed the link in the clear: not the Host's halves, and
    // not the owner's keys or content key, which reach the Host only sealed.
    const crossed = JSON.stringify([
      requested,
      accepted,
      decodeHostRequest(requested.request),
      response,
    ]);
    for (const secret of [...privateParts(saved!), ...privateParts(owner.stored)]) {
      expect(crossed).not.toContain(secret);
    }
    // The Host holds the content key it was granted, and none of the owner's own keys.
    expect(saved!.epochs.map((epoch) => epoch.raw)).toEqual([owner.stored.epochs[0].raw]);
    expect(JSON.stringify(saved)).not.toContain(owner.stored.keys.signing_private_pkcs8);
    expect(JSON.stringify(saved)).not.toContain(owner.stored.keys.exchange_private_pkcs8);

    expect(await link.status()).toEqual({
      ok: true,
      value: {
        kind: "host",
        relayOrigin: owner.stored.config.relayOrigin,
        installationId: owner.installationId,
        deviceId: saved!.config.deviceId,
        ownerDeviceId: owner.deviceId,
        signingPub: saved!.keys.signing_public,
        exchangePub: saved!.keys.exchange_public,
      },
    });
  });

  it.each([
    ["weak", "No keyring is available"],
    ["locked", "The keychain is locked"],
    ["unavailable", "Secure storage is unavailable"],
    ["timeout", "The keychain didn't answer in time"],
  ] as const)(
    "makes no keys when its keychain is %s, so the owner never registers one",
    async (kind, reason) => {
      const { host, client } = await pair();
      const keys = memoryKeys();
      keys.state.keychain = { kind, reason };
      serve(host, new HostEnrollments({ openKeys: keys.open }));
      const link = linkOver(client);

      expect(await link.request({ attempt: "attempt_0000000001", label: HOST })).toEqual({
        ok: true,
        value: { step: "refused", reason: "no-keychain", detail: reason },
      });
      // Nothing was kept for that attempt: an enrollment for it is refused.
      const owner = await makeOwner();
      const other = await pair();
      const keysElsewhere = memoryKeys();
      serve(other.host, new HostEnrollments({ openKeys: keysElsewhere.open }));
      const elsewhere = await enrollOver(linkOver(other.client), owner);
      expect(
        await link.accept({ attempt: "attempt_0000000001", response: elsewhere.response })
      ).toEqual({ ok: true, value: { step: "refused", reason: "stale-attempt" } });
      expect(keys.current()).toBeNull();
    }
  );

  it("never replaces its own owner setup, and refuses another enrollment once enrolled", async () => {
    const owner = await makeOwner();
    {
      const { host, client } = await pair();
      serve(host, new HostEnrollments({ openKeys: memoryKeys(owner.stored).open }));
      const link = linkOver(client);
      expect(await link.status()).toEqual({ ok: true, value: { kind: "owner" } });
      expect(await link.request({ attempt: "attempt_0000000001", label: HOST })).toEqual({
        ok: true,
        value: { step: "refused", reason: "own-setup" },
      });
    }

    const { host, client } = await pair();
    const keys = memoryKeys();
    serve(host, new HostEnrollments({ openKeys: keys.open }));
    const link = linkOver(client);
    await enrollOver(link, owner);
    const enrolled = keys.current();
    expect(await link.request({ attempt: "attempt_0000000002", label: HOST })).toEqual({
      ok: true,
      value: { step: "refused", reason: "enrolled" },
    });
    expect(keys.current()).toEqual(enrolled);
  });

  it("accepts an enrollment only over the link its keys were made for", async () => {
    const owner = await makeOwner();
    const first = await pair();
    const second = await pair();
    const keys = memoryKeys();
    const enrollment = new HostEnrollments({ openKeys: keys.open });
    serve(first.host, enrollment);
    serve(second.host, enrollment);
    const asked = linkOver(first.client);
    const other = linkOver(second.client);

    const requested = await asked.request({ attempt: "attempt_0000000001", label: HOST });
    if (!requested.ok || requested.value.step !== "requested") throw new Error("not requested");
    const { response } = await enrollHost(owner.client, requested.value.request);

    expect(await other.accept({ attempt: "attempt_0000000001", response })).toEqual({
      ok: true,
      value: { step: "refused", reason: "stale-attempt" },
    });
    expect(keys.current()).toBeNull();
    // A try from another link leaves the attempt to the link it was made for.
    expect(await asked.accept({ attempt: "attempt_0000000001", response })).toMatchObject({
      ok: true,
      value: { step: "accepted" },
    });
  });

  it("drops a link's keys when it closes, so its enrollment can't be accepted after", async () => {
    const owner = await makeOwner();
    const { host, client } = await pair();
    const keys = memoryKeys();
    const enrollment = new HostEnrollments({ openKeys: keys.open });
    const forget = vi.spyOn(enrollment, "forget");
    serve(host, enrollment);
    const link = linkOver(client);
    const requested = await link.request({ attempt: "attempt_0000000001", label: HOST });
    if (!requested.ok || requested.value.step !== "requested") throw new Error("not requested");
    const { response } = await enrollHost(owner.client, requested.value.request);

    client.close("test");
    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith(host));
    // The session object is what the keys were bound to: even it can't use them now.
    expect(await enrollment.accept(host, { attempt: "attempt_0000000001", response })).toEqual({
      step: "refused",
      reason: "stale-attempt",
    });
    expect(keys.current()).toBeNull();
  });

  it("keeps no keys a closed link's request finishes making", async () => {
    const owner = await makeOwner();
    const keys = memoryKeys();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const enrollment = new HostEnrollments({
      openKeys: () => {
        const opened = keys.open();
        return {
          ...opened,
          check: async () => {
            await held;
            return opened.check();
          },
        };
      },
    });
    const link = {};
    const asking = enrollment.request(link, { attempt: "attempt_0000000001", label: HOST });
    enrollment.forget(link);
    release();
    await expect(asking).rejects.toThrow("closed");

    // A request made for another link gives a valid enrollment; the closed link has none to accept.
    const other = {};
    const requested = await enrollment.request(other, {
      attempt: "attempt_0000000002",
      label: HOST,
    });
    if (requested.step !== "requested") throw new Error("not requested");
    const { response } = await enrollHost(owner.client, requested.request);
    expect(await enrollment.accept(link, { attempt: "attempt_0000000001", response })).toEqual({
      step: "refused",
      reason: "stale-attempt",
    });
  });

  it("never writes over an identity saved on the Host while it was being enrolled", async () => {
    const owner = await makeOwner();
    const ownSetup = await makeOwner({
      installationId: "inst_own_setup_001",
      deviceId: "dev_own_setup_0001",
    });
    const { host, client } = await pair();
    const keys = memoryKeys();
    // The library reads the file twice while it accepts, the second time right
    // before it writes. The person's own setup lands just after that read, so
    // only the write's own check can see it.
    let accepting = false;
    let loads = 0;
    serve(
      host,
      new HostEnrollments({
        openKeys: () => {
          const opened = keys.open();
          return {
            ...opened,
            load: async () => {
              const value = await opened.load();
              if (accepting && ++loads === 2) keys.replace(ownSetup.stored);
              return value;
            },
          };
        },
      })
    );
    const link = linkOver(client);
    const requested = await link.request({ attempt: "attempt_0000000001", label: HOST });
    if (!requested.ok || requested.value.step !== "requested") throw new Error("not requested");
    const { response } = await enrollHost(owner.client, requested.value.request);

    accepting = true;
    const accepted = await link.accept({ attempt: "attempt_0000000001", response });
    expect(loads).toBe(2);
    expect(accepted).toMatchObject({ ok: true, value: { step: "refused" } });
    expect(keys.current()).toEqual(ownSetup.stored);
  });

  it("refuses an enrollment that doesn't match the keys it made", async () => {
    const owner = await makeOwner();
    const { host, client } = await pair();
    const keys = memoryKeys();
    serve(host, new HostEnrollments({ openKeys: keys.open }));
    const link = linkOver(client);
    await link.request({ attempt: "attempt_0000000001", label: HOST });

    // An enrollment issued for another Host's request.
    const other = await pair();
    serve(other.host, new HostEnrollments({ openKeys: memoryKeys().open }));
    const otherLink = linkOver(other.client);
    const elsewhere = await otherLink.request({
      attempt: "attempt_0000000002",
      label: "studio-04",
    });
    if (!elsewhere.ok || elsewhere.value.step !== "requested") throw new Error("not requested");
    const { response } = await enrollHost(owner.client, elsewhere.value.request);

    const accepted = await link.accept({ attempt: "attempt_0000000001", response });
    expect(accepted).toMatchObject({ ok: true, value: { step: "refused", reason: "rejected" } });
    expect(keys.current()).toBeNull();
  });

  it("replaces a revoked identity of the same owner when asked to, and never another owner's", async () => {
    const owner = await makeOwner();
    const { host, client } = await pair();
    const keys = memoryKeys();
    serve(host, new HostEnrollments({ openKeys: keys.open }));
    const link = linkOver(client);
    await enrollOver(link, owner);
    const revoked = keys.current()!;
    owner.revoke(revoked.config.deviceId);
    // Not named, it is never replaced.
    expect(await link.request({ attempt: "attempt_0000000004", label: HOST })).toEqual({
      ok: true,
      value: { step: "refused", reason: "enrolled" },
    });

    // Another owner naming it is refused, and the identity stays.
    const stranger = await makeOwner({
      installationId: "inst_stranger_0123",
      deviceId: "dev_stranger_0001",
    });
    const refused = await enrollOver(link, stranger, {
      attempt: "attempt_0000000002",
      replace: revoked.config.deviceId,
    });
    expect(refused.accepted).toMatchObject({
      ok: true,
      value: { step: "refused", reason: "rejected" },
    });
    expect(keys.current()).toEqual(revoked);

    const again = await enrollOver(link, owner, {
      attempt: "attempt_0000000003",
      replace: revoked.config.deviceId,
    });
    expect(again.accepted).toMatchObject({ ok: true, value: { step: "accepted" } });
    expect(keys.current()?.config.deviceId).not.toBe(revoked.config.deviceId);
    expect(keys.current()?.host?.ownerCert.signing_pub).toBe(owner.identity.signingPub);
  });

  it("says an older Host needs updating, and reads nothing it can't trust", async () => {
    const { host, client } = await pair();
    const link = linkOver(client);
    // A host from before the method: no handler at all.
    expect(await link.status()).toEqual({ ok: false, failure: "needs-update" });

    host.registerCallHandler(DecisionsLinkMethod.ENROLL_HOST, z.unknown(), () => ({
      step: "status",
      identity: { kind: "host", deviceId: "not enough" },
    }));
    expect(await link.status()).toEqual({ ok: false, failure: "unexpected-answer" });
  });

  it("never sends a payload the Host would refuse", async () => {
    const { client } = await pair();
    const link = linkOver(client);
    await expect(link.request({ attempt: "short", label: HOST })).rejects.toThrow();
  });
});
