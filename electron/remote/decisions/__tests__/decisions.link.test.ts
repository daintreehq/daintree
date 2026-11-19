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
import type { DecisionsHostRuntime } from "../../../../shared/types/decisionsHosts.js";
import type {
  DecisionQuestionContent,
  DecisionQuestionReference,
} from "../../../../shared/types/decisionsQuestion.js";
import type {
  DecisionsHostLink,
  DecisionsHostQuestionRead,
  HeldHost,
  OwnerStateAnnouncement,
} from "../../../types/decisionsHosts.js";
import { HostEnrollments } from "../../../services/decisions/hostEnrollmentHost.js";
import type { LinkSession } from "../../link/session.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import { DecisionsHostsClient } from "../client.js";
import {
  installDecisionsHostWith,
  type DecisionsHostEnrollment,
  type DecisionsHostLifetime,
} from "../host.js";
import { DECISIONS_LINK_METHOD_LOCALITY, DecisionsLinkMethod } from "../linkMethods.js";
import {
  MAX_HOST_IMAGE_PART_BYTES,
  MAX_HOST_QUESTION_LIST_BYTES,
  type HostQuestionList,
} from "../questionSchemas.js";
import { QUESTION_IMAGE_PART_BYTES } from "../../../services/decisions/questionContent.js";
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
    ownerState: () => null,
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

  it("enrolls a Host with no keychain under the fixed key, over the link, only when the owner accepted it", async () => {
    const { host, client } = await pair();
    const keys = memoryKeys();
    keys.state.keychain = { kind: "weak", reason: "No keyring is available" };
    serve(host, new HostEnrollments({ openKeys: keys.open }));
    const link = linkOver(client);
    const owner = await makeOwner();

    const requested = await link.request({
      attempt: "attempt_0000000001",
      label: HOST,
      allowWeakStorage: true,
    });
    if (!requested.ok || requested.value.step !== "requested") {
      throw new Error(JSON.stringify(requested));
    }
    const { response } = await enrollHost(owner.client, requested.value.request);
    expect(await link.accept({ attempt: "attempt_0000000001", response })).toMatchObject({
      ok: true,
      value: { step: "accepted" },
    });
    expect(keys.state.weakSaves).toBe(1);
    expect(keys.current()?.role).toBe("desktop-host");
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
        value: {
          step: "refused",
          // With no keychain at all, the fixed-key storage is offered, only on the owner's say-so.
          reason: kind === "weak" ? "weak-storage-only" : "no-keychain",
          detail: reason,
        },
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

describe("an enrolled Host's own Decisions over its link (#16022)", () => {
  const OWNER: OwnerStateAnnouncement = {
    installationId: "inst_owner_0123456789",
    ownerDeviceId: "dev_owner_desktop_01",
    enabled: true,
    terminalSnapshots: false,
  };
  const RUNNING = {
    state: "running",
    deviceId: "dev_host_studio_01",
    connection: "connected",
  } as const satisfies DecisionsHostRuntime;

  /** The Host's lifetime as a fake: what it was told, and a report the test sets and announces. */
  function hostLifetime(enrolledOwner: string | null = OWNER.ownerDeviceId) {
    const applied: OwnerStateAnnouncement[] = [];
    const adopted: Array<{ deviceId: string; ownerEnabled: boolean | undefined }> = [];
    const listeners = new Set<() => void>();
    let report: DecisionsHostRuntime = RUNNING;
    const lifetime: DecisionsHostLifetime = {
      apply: async (state) => {
        applied.push(state);
        report = state.enabled
          ? RUNNING
          : { state: "owner-off", deviceId: RUNNING.deviceId, since: 1_000 };
        return report;
      },
      reportFor: () => report,
      adopt: async (held, ownerEnabled) => {
        adopted.push({ deviceId: held.deviceId, ownerEnabled });
      },
      onChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      questions: () => null,
      onQuestionsChanged: () => () => {},
      readQuestion: async () => ({ result: "not-running" }),
      cancelQuestion: async () => ({ result: "not-running" }),
    };
    const load = vi.fn(async () => lifetime);
    return {
      applied,
      adopted,
      load,
      source: {
        enrolledBy: (owner: { ownerDeviceId: string }) => owner.ownerDeviceId === enrolledOwner,
        load,
      },
      /** The Host's Decisions changed by itself, as a reconnect would. */
      change(next: DecisionsHostRuntime) {
        report = next;
        for (const listener of listeners) listener();
      },
      listening: () => listeners.size,
    };
  }

  function serveLifetime(
    session: LinkSession,
    lifetime: ReturnType<typeof hostLifetime>,
    enrollment: (onHeld: (held: HeldHost) => void) => Promise<DecisionsHostEnrollment> = vi.fn(
      async () => {
        throw new Error("enrollment isn't asked for here");
      }
    )
  ) {
    const uninstall = installDecisionsHostWith(
      { sessions: [{ session }], onSession: () => () => {} },
      enrollment,
      lifetime.source
    );
    uninstalls.push(uninstall);
    return { enrollment, uninstall };
  }

  function shellOver(session: LinkSession, ownerState: () => OwnerStateAnnouncement | null) {
    const client = new DecisionsHostsClient({
      hosts: () => [{ hostId: HOST, name: HOST }],
      sessionFor: (hostId) => (hostId === HOST ? session : null),
      onSessionOpened: () => () => {},
      onHostsChanged: () => () => {},
      hold: () => () => {},
      ownerState,
      now: () => 5_000,
    });
    const changed = vi.fn();
    client.onHostsChanged(changed);
    uninstalls.push(client.start());
    return { client, changed };
  }

  it("is served by the Host, and its reports by the Shell", () => {
    expect(DECISIONS_LINK_METHOD_LOCALITY[DecisionsLinkMethod.OWNER_STATE]).toBe("host");
    expect(DECISIONS_LINK_METHOD_LOCALITY[DecisionsLinkMethod.OWNER_STATE_V2]).toBe("host");
    expect(DECISIONS_LINK_METHOD_LOCALITY[DecisionsLinkMethod.HOST_RUNTIME]).toBe("shell");
  });

  it("tells the Host whether the owner's terminal snapshots are on (#16230)", async () => {
    const { host, client } = await pair();
    const lifetime = hostLifetime();
    serveLifetime(host, lifetime);
    const sharing = { ...OWNER, terminalSnapshots: true };
    let state: OwnerStateAnnouncement = sharing;
    const { client: shell } = shellOver(client, () => state);

    await vi.waitFor(() => expect(lifetime.applied).toEqual([sharing]));
    state = OWNER;
    shell.announceOwnerState();
    await vi.waitFor(() => expect(lifetime.applied).toEqual([sharing, OWNER]));
  });

  it("tells a Host from before terminal snapshots the older method only, without them", async () => {
    const { host, client } = await pair();
    // A Host from before #16230: the strict older payload, and no v2 method.
    const told: unknown[] = [];
    host.registerCallHandler(
      DecisionsLinkMethod.OWNER_STATE,
      z
        .object({ installationId: z.string(), ownerDeviceId: z.string(), enabled: z.boolean() })
        .strict(),
      (payload) => {
        told.push(payload);
        return { runtime: RUNNING };
      }
    );
    const calls = vi.spyOn(client, "call");
    const { client: shell } = shellOver(client, () => ({ ...OWNER, terminalSnapshots: true }));

    await vi.waitFor(() =>
      expect(shell.runtimeOf(HOST)).toEqual({ runtime: RUNNING, at: 5_000, live: true })
    );
    const { terminalSnapshots: _snapshots, ...earlier } = OWNER;
    expect(told).toEqual([earlier]);

    // Asked once: every later announcement goes straight to the older method.
    shell.announceOwnerState();
    await vi.waitFor(() => expect(told).toHaveLength(2));
    const announcements: string[] = [
      DecisionsLinkMethod.OWNER_STATE_V2,
      DecisionsLinkMethod.OWNER_STATE,
    ];
    expect(
      calls.mock.calls.map(([method]) => method).filter((method) => announcements.includes(method))
    ).toEqual([
      DecisionsLinkMethod.OWNER_STATE_V2,
      DecisionsLinkMethod.OWNER_STATE,
      DecisionsLinkMethod.OWNER_STATE,
    ]);
  });

  it("reads a Shell from before terminal snapshots as sharing none", async () => {
    const { host, client } = await pair();
    const lifetime = hostLifetime();
    serveLifetime(host, lifetime);
    const { terminalSnapshots: _snapshots, ...earlier } = OWNER;

    await client.call(DecisionsLinkMethod.OWNER_STATE, earlier);

    expect(lifetime.applied).toEqual([{ ...earlier, terminalSnapshots: false }]);
  });

  it("tells the Host the owner's switch as the link comes up, and keeps what it reports", async () => {
    const { host, client } = await pair();
    const lifetime = hostLifetime();
    serveLifetime(host, lifetime);
    const { client: shell, changed } = shellOver(client, () => OWNER);

    await vi.waitFor(() =>
      expect(shell.runtimeOf(HOST)).toEqual({ runtime: RUNNING, at: 5_000, live: true })
    );
    expect(lifetime.applied).toEqual([OWNER]);
    expect(changed).toHaveBeenCalled();

    // The Host's own changes reach the Shell as they happen, each once.
    const pushes = vi.spyOn(host, "call");
    const reconnecting: DecisionsHostRuntime = {
      ...RUNNING,
      connection: "reconnecting",
      nextAttemptAt: 9_000,
    };
    lifetime.change(reconnecting);
    lifetime.change(reconnecting);
    lifetime.change(reconnecting);
    await vi.waitFor(() => expect(shell.runtimeOf(HOST)?.runtime).toEqual(reconnecting));
    expect(pushes.mock.calls.map(([method]) => method)).toEqual([DecisionsLinkMethod.HOST_RUNTIME]);

    // The switch changing here is announced again.
    const off = { ...OWNER, enabled: false };
    let state: OwnerStateAnnouncement = OWNER;
    const second = await pair();
    const lifetimeTwo = hostLifetime();
    serveLifetime(second.host, lifetimeTwo);
    const { client: shellTwo } = shellOver(second.client, () => state);
    await vi.waitFor(() => expect(lifetimeTwo.applied).toEqual([OWNER]));
    state = off;
    shellTwo.announceOwnerState();
    await vi.waitFor(() =>
      expect(shellTwo.runtimeOf(HOST)?.runtime).toEqual({
        state: "owner-off",
        deviceId: RUNNING.deviceId,
        since: 1_000,
      })
    );
    expect(lifetimeTwo.applied).toEqual([OWNER, off]);

    // A closed link leaves the last report standing, as one from before it closed.
    host.close("test");
    await vi.waitFor(() => expect(shell.runtimeOf(HOST)?.live).toBe(false));
    expect(shell.runtimeOf(HOST)?.runtime).toEqual(reconnecting);
  });

  it("loads nothing of Decisions on a Host this owner never enrolled", async () => {
    const { host, client } = await pair();
    const lifetime = hostLifetime("dev_someone_else_01");
    serveLifetime(host, lifetime);
    const { client: shell } = shellOver(client, () => OWNER);

    await vi.waitFor(() =>
      expect(shell.runtimeOf(HOST)?.runtime).toEqual({ state: "not-enrolled" })
    );
    expect(lifetime.load).not.toHaveBeenCalled();
  });

  it("announces nothing from a computer with no owner identity", async () => {
    const { host, client } = await pair();
    const lifetime = hostLifetime();
    serveLifetime(host, lifetime);
    const call = vi.spyOn(client, "call");
    const { client: shell } = shellOver(client, () => null);
    shell.announceOwnerState();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(call).not.toHaveBeenCalled();
    expect(lifetime.load).not.toHaveBeenCalled();
    expect(shell.runtimeOf(HOST)).toBeNull();
  });

  it("stops following the Host's Decisions once its listener stops", async () => {
    const { host, client } = await pair();
    const lifetime = hostLifetime();
    const { uninstall } = serveLifetime(host, lifetime);
    shellOver(client, () => OWNER);
    await vi.waitFor(() => expect(lifetime.listening()).toBe(1));

    await uninstall();
    expect(lifetime.listening()).toBe(0);
  });

  it("takes up an identity held after its owner said Decisions is off as off", async () => {
    const { host, client } = await pair();
    const lifetime = hostLifetime();
    const keys = memoryKeys();
    const owner = await makeOwner({
      installationId: OWNER.installationId,
      deviceId: OWNER.ownerDeviceId,
    });
    serveLifetime(
      host,
      lifetime,
      async (onHeld) => new HostEnrollments({ openKeys: keys.open, onHeld })
    );
    // The owner turned Decisions off while this Host was still being enrolled.
    shellOver(client, () => ({ ...OWNER, enabled: false }));
    await vi.waitFor(() => expect(lifetime.applied).toHaveLength(1));
    const link = linkOver(client);

    const { accepted } = await enrollOver(link, owner);
    expect(accepted).toMatchObject({ ok: true, value: { step: "accepted" } });

    await vi.waitFor(() =>
      expect(lifetime.adopted).toEqual([
        { deviceId: keys.current()!.config.deviceId, ownerEnabled: false },
      ])
    );
  });

  it("keeps a push newer than an announcement's late answer", async () => {
    const { host, client } = await pair();
    let answer!: (report: DecisionsHostRuntime) => void;
    const lifetime = hostLifetime();
    const held = new Promise<DecisionsHostRuntime>((resolve) => {
      answer = resolve;
    });
    lifetime.source.load = vi.fn(async () => ({
      ...(await hostLifetime().source.load()),
      apply: () => held,
      reportFor: () => RUNNING,
    }));
    serveLifetime(host, lifetime);
    const { client: shell } = shellOver(client, () => OWNER);
    await vi.waitFor(() => expect(lifetime.source.load).toHaveBeenCalled());

    const pushed: DecisionsHostRuntime = { ...RUNNING, connection: "reconnecting" };
    await host.call(DecisionsLinkMethod.HOST_RUNTIME, { runtime: pushed });
    answer({ ...RUNNING, connection: "connecting" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(shell.runtimeOf(HOST)?.runtime).toEqual(pushed);
  });

  it("stops hearing a Host's reports once the Shell's client stops", async () => {
    const { host, client } = await pair();
    const lifetime = hostLifetime();
    serveLifetime(host, lifetime);
    const shell = new DecisionsHostsClient({
      hosts: () => [{ hostId: HOST, name: HOST }],
      sessionFor: () => client,
      onSessionOpened: () => () => {},
      onHostsChanged: () => () => {},
      hold: () => () => {},
      ownerState: () => OWNER,
    });
    const stop = shell.start();
    await vi.waitFor(() => expect(shell.runtimeOf(HOST)).not.toBeNull());

    stop();
    await expect(
      host.call(DecisionsLinkMethod.HOST_RUNTIME, {
        runtime: { ...RUNNING, connection: "reconnecting" },
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  /** A Host serving `session` whose key file holds an identity, and whose lifetime loads when the test says. */
  async function heldHost(session: LinkSession, lifetime: ReturnType<typeof hostLifetime>) {
    const owner = await makeOwner({
      installationId: OWNER.installationId,
      deviceId: OWNER.ownerDeviceId,
    });
    const keys = memoryKeys();
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = lifetime.source.load;
    lifetime.source.load = vi.fn(async () => {
      await loaded;
      return load();
    });
    const served = serveLifetime(
      session,
      lifetime,
      async (onHeld) => new HostEnrollments({ openKeys: keys.open, onHeld })
    );
    return { owner, keys, release, ...served };
  }

  it("takes up an identity as its owner last said, after its lifetime loads, and says it again", async () => {
    const { host, client } = await pair();
    const lifetime = hostLifetime();
    const held = await heldHost(host, lifetime);
    let state: OwnerStateAnnouncement = OWNER;
    const { client: shell } = shellOver(client, () => state);
    await enrollOver(linkOver(client), held.owner);

    // Turned off while the Host's lifetime was still loading, with no record to apply it to.
    state = { ...OWNER, enabled: false };
    shell.announceOwnerState();
    await new Promise((resolve) => setTimeout(resolve, 20));
    held.release();

    await vi.waitFor(() =>
      expect(lifetime.adopted).toEqual([
        { deviceId: held.keys.current()!.config.deviceId, ownerEnabled: false },
      ])
    );
    await vi.waitFor(() => expect(lifetime.applied.at(-1)).toEqual(state));
  });

  it("takes nothing up once its installer has stopped, and its stop waits for one under way", async () => {
    const { host, client } = await pair();
    const lifetime = hostLifetime();
    const held = await heldHost(host, lifetime);
    shellOver(client, () => OWNER);
    await enrollOver(linkOver(client), held.owner);

    const stopping = held.uninstall();
    held.release();
    await stopping;

    expect(lifetime.adopted).toEqual([]);
  });

  it("still says the owner's latest word to an adoption under way when its installer stops", async () => {
    const { host, client } = await pair();
    const lifetime = hostLifetime();
    const held = await heldHost(host, lifetime);
    let adopting!: () => void;
    const adopted = new Promise<void>((resolve) => {
      adopting = resolve;
    });
    // No record until the adoption finishes: an announcement meanwhile is only remembered.
    let enrolled = false;
    lifetime.source.enrolledBy = () => enrolled;
    const made = await lifetime.source.load.getMockImplementation()!;
    lifetime.source.load = vi.fn(async () => {
      const real = await made();
      return {
        ...real,
        adopt: async () => {
          await adopted;
          enrolled = true;
        },
      };
    });
    let state: OwnerStateAnnouncement = OWNER;
    const { client: shell } = shellOver(client, () => state);
    await enrollOver(linkOver(client), held.owner);
    held.release();
    state = { ...OWNER, enabled: false };
    shell.announceOwnerState();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stopping = held.uninstall();
    adopting();
    await stopping;

    expect(lifetime.applied.at(-1)).toEqual(state);
  });
});

describe("an enrolled Host's questions over its link (#17230)", () => {
  const OWNER: OwnerStateAnnouncement = {
    installationId: "inst_owner_0123456789",
    ownerDeviceId: "dev_owner_desktop_01",
    enabled: true,
    terminalSnapshots: false,
  };
  const RUNNING = {
    state: "running",
    deviceId: "dev_host_studio_01",
    connection: "connected",
  } as const satisfies DecisionsHostRuntime;
  /** The id the Host's own questions name it by, never its host list id. */
  const QHOST = "qhost_studio_0001";

  type Item = HostQuestionList["questions"][number];

  function item(n: number, standing: Item["standing"] = { kind: "waiting", reason: "open" }): Item {
    return {
      reference: {
        hostId: QHOST,
        projectId: "project-server",
        terminalId: `pane-${n}`,
        questionId: `q_host_${String(n).padStart(4, "0")}`,
      },
      alias: n,
      agentKind: "claude",
      projectLabel: "Server repo",
      worktreeId: "wt-main",
      worktreeRoot: "/srv/repo",
      requirement: "human-required",
      askedAt: `2026-11-02T10:0${n}:00.000Z`,
      expiresAt: null,
      settledAt: null,
      standing,
      replyRequest: null,
      stall: null,
    };
  }

  function content(reference: DecisionQuestionReference): DecisionQuestionContent {
    return {
      questionId: reference.questionId,
      alias: 1,
      terminalId: reference.terminalId,
      reference,
      revision: 3,
      question: "Ship the migration?",
      context: null,
      kind: "approval",
      options: [{ id: "yes", label: "Yes", description: null }],
      allowText: false,
      requirement: "human-required",
      askedAt: "2026-11-02T10:01:00.000Z",
      expiresAt: null,
      status: "open",
      closedReason: null,
      deliveryStatus: "not-sent",
      attachments: [],
      thread: [],
    };
  }

  /** A Host's Decisions as a fake: its questions, set by the test, and what it was asked. */
  function questionHost(enrolledOwner: string = OWNER.ownerDeviceId) {
    let list: HostQuestionList | null = null;
    const listeners = new Set<() => void>();
    const reads: DecisionsHostQuestionRead[] = [];
    const cancels: DecisionQuestionReference[] = [];
    let answer: (read: DecisionsHostQuestionRead) => unknown = (read) =>
      read.read === "content" ? { result: "read", question: content(read.reference) } : null;
    const lifetime: DecisionsHostLifetime = {
      apply: async () => RUNNING,
      reportFor: () => RUNNING,
      adopt: async () => {},
      onChanged: () => () => {},
      questions: () => list,
      onQuestionsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      readQuestion: async (read) => {
        reads.push(read);
        return answer(read) as Awaited<ReturnType<DecisionsHostLifetime["readQuestion"]>>;
      },
      cancelQuestion: async (reference) => {
        cancels.push(reference);
        return { result: "cancelling" };
      },
    };
    return {
      reads,
      cancels,
      source: {
        enrolledBy: (owner: { ownerDeviceId: string }) => owner.ownerDeviceId === enrolledOwner,
        load: vi.fn(async () => lifetime),
      },
      /** The Host's questions changed, as a commit to its store would change them. */
      set(next: HostQuestionList | null) {
        list = next;
        for (const listener of listeners) listener();
      },
      answerWith(next: (read: DecisionsHostQuestionRead) => unknown) {
        answer = next;
      },
    };
  }

  function serveQuestions(session: LinkSession, host: ReturnType<typeof questionHost>) {
    uninstalls.push(
      installDecisionsHostWith(
        { sessions: [{ session }], onSession: () => () => {} },
        vi.fn(async () => {
          throw new Error("enrollment isn't asked for here");
        }),
        host.source
      )
    );
  }

  /**
   * The owner's Shell, with each Host's current session set by the test and a
   * new one announced as the Remote Hosts client would.
   */
  function shellOf(hosts: Array<{ hostId: string; name: string }>) {
    const sessions = new Map<string, LinkSession>();
    const opened = new Set<(hostId: string, session: LinkSession) => void>();
    let owner: OwnerStateAnnouncement | null = OWNER;
    const client = new DecisionsHostsClient({
      hosts: () => hosts,
      sessionFor: (hostId) => sessions.get(hostId) ?? null,
      onSessionOpened: (listener) => {
        opened.add(listener);
        return () => opened.delete(listener);
      },
      onHostsChanged: () => () => {},
      hold: () => () => {},
      ownerState: () => owner,
    });
    const changed = vi.fn();
    client.onHostQuestionsChanged(changed);
    uninstalls.push(client.start());
    return {
      client,
      changed,
      open(hostId: string, session: LinkSession) {
        sessions.set(hostId, session);
        for (const listener of opened) listener(hostId, session);
      },
      setOwner(next: OwnerStateAnnouncement | null) {
        owner = next;
      },
    };
  }

  const STUDIO = { hostId: HOST, name: "Studio" };

  /**
   * A Host's side of the link reduced to its announcements: it takes each
   * owner's word and answers `runtime()`. Read for its questions it answers
   * `list()`, by default none, so the test sends its lists itself; with
   * `list` null it is a build from before them.
   */
  function answerAnnouncements(
    session: LinkSession,
    runtime: () => DecisionsHostRuntime = () => RUNNING,
    list: (() => unknown) | null = () => ({ hostId: null, owner: null, questions: [] })
  ) {
    session.registerCallHandler(DecisionsLinkMethod.OWNER_STATE_V2, z.unknown(), () => ({
      runtime: runtime(),
    }));
    if (list !== null)
      session.registerCallHandler(DecisionsLinkMethod.QUESTIONS, z.unknown(), list);
  }

  /** The owner a Host names a list it serves this test's Shell with. */
  const SERVED = { installationId: OWNER.installationId, ownerDeviceId: OWNER.ownerDeviceId };

  it("takes an image part as large as a Host's Decisions reads them", () => {
    expect(MAX_HOST_IMAGE_PART_BYTES).toBe(QUESTION_IMAGE_PART_BYTES);
  });

  it("sends its newest questions that fit one message, never more", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    const long = (n: number): Item => ({ ...item(n), worktreeRoot: `/srv/${"r".repeat(4_000)}` });
    const all = Array.from({ length: 1_500 }, (_, i) => long(i + 1));
    decisions.set({ hostId: QHOST, questions: all });
    serveQuestions(host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);

    await vi.waitFor(() => expect(shell.client.hostQuestions()).toHaveLength(1));
    const heard = shell.client.hostQuestions()[0]!.questions;
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.length).toBeLessThan(all.length);
    expect(heard).toEqual(all.slice(-heard.length));
    expect(
      Buffer.byteLength(JSON.stringify({ hostId: QHOST, questions: heard }))
    ).toBeLessThanOrEqual(MAX_HOST_QUESTION_LIST_BYTES);
  });

  it("sends at most its newest 2000 questions, a worktree id as long as a path included", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    const all = Array.from({ length: 2_001 }, (_, i) => item(i + 1));
    all[2_000] = { ...all[2_000]!, worktreeId: `/srv/worktrees/${"w".repeat(300)}` };
    decisions.set({ hostId: QHOST, questions: all });
    serveQuestions(host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);

    await vi.waitFor(() => expect(shell.client.hostQuestions()).toHaveLength(1));
    expect(shell.client.hostQuestions()[0]!.questions).toEqual(all.slice(1));
  });

  it("is asked of the Host, and its changes are told to the Shell", () => {
    expect(DECISIONS_LINK_METHOD_LOCALITY[DecisionsLinkMethod.QUESTIONS]).toBe("host");
    expect(DECISIONS_LINK_METHOD_LOCALITY[DecisionsLinkMethod.CANCEL_QUESTION]).toBe("host");
    expect(DECISIONS_LINK_METHOD_LOCALITY[DecisionsLinkMethod.QUESTIONS_CHANGED]).toBe("shell");
  });

  it("lists a Host's questions as its link comes up, and each change as it happens", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    decisions.set({ hostId: QHOST, questions: [item(1)] });
    serveQuestions(host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);

    // Read with what each asks (#17895): none reported, as this fake's list names none.
    await vi.waitFor(() =>
      expect(shell.client.hostQuestions()).toEqual([
        {
          ...STUDIO,
          connected: true,
          questionHostId: QHOST,
          questions: [item(1)],
          asks: new Map(),
        },
      ])
    );

    const pushes = vi.spyOn(host, "call");
    const answered = item(1, { kind: "settled", outcome: "answered", handled: false });
    const changed = { hostId: QHOST, questions: [answered, item(2)] };
    decisions.set(changed);
    // Told once: the same list again isn't sent.
    decisions.set({ hostId: QHOST, questions: [answered, item(2)] });
    await vi.waitFor(() =>
      expect(shell.client.hostQuestions()[0]?.questions).toEqual([answered, item(2)])
    );
    expect(pushes.mock.calls.map(([method]) => method)).toEqual([
      DecisionsLinkMethod.QUESTIONS_CHANGED_V2,
    ]);
    expect(shell.changed).toHaveBeenCalled();
  });

  it("keeps a Host's last questions when its link closes, as not connected, until the next link's", async () => {
    const first = await pair();
    const decisions = questionHost();
    decisions.set({ hostId: QHOST, questions: [item(1)] });
    serveQuestions(first.host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, first.client);
    await vi.waitFor(() => expect(shell.client.hostQuestions()[0]?.connected).toBe(true));
    shell.changed.mockClear();

    first.host.close("test");
    await vi.waitFor(() => expect(shell.client.hostQuestions()[0]?.connected).toBe(false));
    expect(shell.client.hostQuestions()[0]?.questions).toEqual([item(1)]);
    expect(shell.changed).toHaveBeenCalled();
    // Nothing reaches a Host whose link is down: it isn't connected.
    expect(
      await shell.client.readHostQuestion(QHOST, { read: "content", reference: item(1).reference })
    ).toEqual({ ok: false, failure: "disconnected" });

    // What the Host stopped serving while away says nothing: the next link's list replaces it.
    const second = await pair();
    const expired = item(1, { kind: "settled", outcome: "expired" });
    decisions.set({ hostId: QHOST, questions: [expired] });
    serveQuestions(second.host, decisions);
    shell.open(HOST, second.client);
    await vi.waitFor(() =>
      expect(shell.client.hostQuestions()).toEqual([
        {
          ...STUDIO,
          connected: true,
          questionHostId: QHOST,
          questions: [expired],
          asks: new Map(),
        },
      ])
    );
  });

  it("keeps what it last heard when the Host stops serving its questions", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    decisions.set({ hostId: QHOST, questions: [item(1)] });
    serveQuestions(host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() => expect(shell.client.hostQuestions()).toHaveLength(1));
    const pushes = vi.spyOn(host, "call");

    // Its Decisions stopped (quitting, its store closing): nothing is sent, and nothing is lost.
    decisions.set(null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pushes).not.toHaveBeenCalled();
    expect(shell.client.hostQuestions()[0]?.questions).toEqual([item(1)]);
  });

  it("serves nothing of its questions to a Shell whose owner didn't enroll it", async () => {
    const { host, client } = await pair();
    const decisions = questionHost("dev_another_owner_01");
    decisions.set({ hostId: QHOST, questions: [item(1)] });
    serveQuestions(host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() =>
      expect(shell.client.runtimeOf(HOST)?.runtime.state).toBe("not-enrolled")
    );
    const pushes = vi.spyOn(host, "call");

    decisions.set({ hostId: QHOST, questions: [item(1), item(2)] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(shell.client.hostQuestions()).toEqual([]);
    expect(pushes).not.toHaveBeenCalled();
    expect(
      await client.call(DecisionsLinkMethod.QUESTIONS, {
        read: "content",
        reference: item(1).reference,
      })
    ).toEqual({ result: "off" });
    expect(
      await client.call(DecisionsLinkMethod.CANCEL_QUESTION, { reference: item(1).reference })
    ).toEqual({ result: "off" });
    expect(decisions.reads).toEqual([]);
    expect(decisions.cancels).toEqual([]);
  });

  it("reads and withdraws a Host's question on that Host, and takes no answer about another one", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    decisions.set({ hostId: QHOST, questions: [item(1)] });
    serveQuestions(host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() => expect(shell.client.hostQuestions()).toHaveLength(1));
    const { reference } = item(1);

    expect(await shell.client.readHostQuestion(QHOST, { read: "content", reference })).toEqual({
      ok: true,
      value: { result: "read", question: content(reference) },
    });
    // An id no Host's questions name has no Host to read it on.
    expect(shell.client.readHostQuestion("qhost_unknown_001", { read: "content", reference })).toBe(
      null
    );

    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    decisions.answerWith((read) => {
      if (read.read === "image") {
        return {
          result: "read",
          part: {
            attachmentId: read.attachmentId,
            mime: "image/png",
            sha256: "a".repeat(64),
            bytes,
            size: bytes.byteLength,
            offset: read.offset,
          },
        };
      }
      if (read.read === "summaries") {
        return {
          result: "read",
          summaries: read.references.map(({ questionId }) => ({
            questionId,
            result: "read",
            line: "Ship the migration?",
          })),
        };
      }
      // Content of another question than the one asked for.
      return { result: "read", question: content({ ...reference, terminalId: "pane-other" }) };
    });
    const image = { read: "image", reference, attachmentId: "att_00000001", offset: 0 } as const;
    const imageRead = await shell.client.readHostQuestion(QHOST, image);
    expect(
      imageRead?.ok && imageRead.value.result === "read" ? [...imageRead.value.part.bytes] : null
    ).toEqual([...bytes]);
    expect(
      await shell.client.readHostQuestion(QHOST, { read: "summaries", references: [reference] })
    ).toEqual({
      ok: true,
      value: {
        result: "read",
        summaries: [
          { questionId: reference.questionId, result: "read", line: "Ship the migration?" },
        ],
      },
    });
    expect(await shell.client.readHostQuestion(QHOST, { read: "content", reference })).toEqual({
      ok: false,
      failure: "unexpected-answer",
    });
    // Content naming the question asked, from another project, is another question.
    decisions.answerWith(() => ({
      result: "read",
      question: content({ ...reference, projectId: "project-other" }),
    }));
    expect(await shell.client.readHostQuestion(QHOST, { read: "content", reference })).toEqual({
      ok: false,
      failure: "unexpected-answer",
    });

    // A part of another image, one cut short, and opening lines not asked for are refused too.
    const part = (attachmentId: string, size: number) => ({
      result: "read",
      part: { attachmentId, mime: "image/png", sha256: "a".repeat(64), bytes, size, offset: 0 },
    });
    decisions.answerWith(() => part("att_00000002", bytes.byteLength));
    expect(await shell.client.readHostQuestion(QHOST, image)).toEqual({
      ok: false,
      failure: "unexpected-answer",
    });
    decisions.answerWith(() => part("att_00000001", bytes.byteLength + 10));
    expect(await shell.client.readHostQuestion(QHOST, image)).toEqual({
      ok: false,
      failure: "unexpected-answer",
    });
    const summary = { questionId: reference.questionId, result: "read", line: "Twice?" };
    decisions.answerWith(() => ({ result: "read", summaries: [summary, summary] }));
    expect(
      await shell.client.readHostQuestion(QHOST, { read: "summaries", references: [reference] })
    ).toEqual({ ok: false, failure: "unexpected-answer" });
    decisions.answerWith(() => ({
      result: "read",
      summaries: [{ questionId: "q_not_asked_0001", result: "not-found" }],
    }));
    expect(
      await shell.client.readHostQuestion(QHOST, { read: "summaries", references: [reference] })
    ).toEqual({ ok: false, failure: "unexpected-answer" });

    expect(await shell.client.cancelHostQuestion(reference)).toEqual({
      ok: true,
      value: { result: "cancelling" },
    });
    expect(decisions.cancels).toEqual([reference]);
    expect(decisions.reads.map((read) => read.read)).toEqual([
      "content",
      "image",
      "summaries",
      "content",
      "content",
      "image",
      "image",
      "summaries",
      "summaries",
    ]);
  });

  it("reads a question with a long thread whole", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    decisions.set({ hostId: QHOST, questions: [item(1)] });
    const thread = Array.from({ length: 5_000 }, (_, i) => ({
      type: "expired" as const,
      entryId: `entry_${i}`,
      sentAt: "2026-11-02T10:01:00.000Z",
    }));
    decisions.answerWith((read) =>
      read.read === "content"
        ? { result: "read", question: { ...content(read.reference), thread } }
        : null
    );
    serveQuestions(host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() => expect(shell.client.hostQuestions()).toHaveLength(1));

    const read = await shell.client.readHostQuestion(QHOST, {
      read: "content",
      reference: item(1).reference,
    });
    expect(read?.ok && read.value.result === "read" ? read.value.question.thread : null).toEqual(
      thread
    );
  });

  it("carries a Host's reply requests, stalls and declines across the link", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    const replying: Item = {
      ...item(1, { kind: "settled", outcome: "answered", handled: false }),
      replyRequest: "msg_agent_0001",
    };
    const stalled: Item = {
      ...item(2, { kind: "needs-attention", deliveryStatus: "needs-attention" }),
      stall: { answerRevision: 2, followUpIds: ["msg_person_0001"], reason: "pane_gone" },
    };
    const declined = item(3, { kind: "settled", outcome: "declined" });
    decisions.set({ hostId: QHOST, questions: [replying, stalled, declined] });
    const thread = [
      { type: "declined" as const, entryId: "entry_decline", sentAt: "2026-11-02T10:04:00.000Z" },
    ];
    decisions.answerWith((read) =>
      read.read === "content"
        ? {
            result: "read",
            question: {
              ...content(read.reference),
              status: "cancelled",
              closedReason: "declined",
              thread,
            },
          }
        : null
    );
    serveQuestions(host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);

    await vi.waitFor(() =>
      expect(shell.client.hostQuestions()[0]?.questions).toEqual([replying, stalled, declined])
    );
    const read = await shell.client.readHostQuestion(QHOST, {
      read: "content",
      reference: declined.reference,
    });
    const question = read?.ok && read.value.result === "read" ? read.value.question : null;
    expect(question?.closedReason).toBe("declined");
    expect(question?.thread).toEqual(thread);
  });

  it("keeps only what names the Host's own id, and lists neither of two Hosts naming the same one", async () => {
    const studio = await pair();
    const lab = await pair();
    const LAB = { hostId: "lab-01", name: "Lab" };
    // Each says it is enrolled by this owner as it takes the announcement.
    answerAnnouncements(studio.host);
    answerAnnouncements(lab.host);
    const shell = shellOf([STUDIO, LAB]);
    shell.open(HOST, studio.client);
    shell.open(LAB.hostId, lab.client);
    await vi.waitFor(() => {
      expect(shell.client.runtimeOf(HOST)?.runtime).toEqual(RUNNING);
      expect(shell.client.runtimeOf(LAB.hostId)?.runtime).toEqual(RUNNING);
    });
    const foreign = { ...item(2), reference: { ...item(2).reference, hostId: "qhost_other_001" } };
    await studio.host.call(DecisionsLinkMethod.QUESTIONS_CHANGED, {
      hostId: QHOST,
      owner: SERVED,
      questions: [item(1), foreign, { reference: "not a question" }],
    });
    expect(shell.client.hostQuestions()).toEqual([
      { ...STUDIO, connected: true, questionHostId: QHOST, questions: [item(1)] },
    ]);

    // Another Host claiming the same id: neither is listed, and neither is read through.
    await lab.host.call(DecisionsLinkMethod.QUESTIONS_CHANGED, {
      hostId: QHOST,
      owner: SERVED,
      questions: [item(3)],
    });
    expect(shell.client.hostQuestions()).toEqual([]);
    expect(
      shell.client.readHostQuestion(QHOST, { read: "content", reference: item(1).reference })
    ).toBe(null);
  });

  it("lists nothing it heard for another owner identity, or for a Host no longer enrolled", async () => {
    const { host, client } = await pair();
    answerAnnouncements(host, () => ({ state: "not-enrolled" }));
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() => expect(shell.client.runtimeOf(HOST)).not.toBeNull());
    // Nothing a Host sends counts while it doesn't report itself enrolled by this owner.
    await host.call(DecisionsLinkMethod.QUESTIONS_CHANGED, {
      hostId: QHOST,
      owner: SERVED,
      questions: [item(1)],
    });
    expect(shell.client.hostQuestions()).toEqual([]);
    await host.call(DecisionsLinkMethod.HOST_RUNTIME, { runtime: RUNNING });
    expect(shell.client.hostQuestions()).toHaveLength(1);

    shell.setOwner({ ...OWNER, ownerDeviceId: "dev_owner_desktop_02" });
    expect(shell.client.hostQuestions()).toEqual([]);
    shell.setOwner(OWNER);
    expect(shell.client.hostQuestions()).toHaveLength(1);

    shell.changed.mockClear();
    await host.call(DecisionsLinkMethod.HOST_RUNTIME, {
      runtime: {
        state: "revoked",
        deviceId: RUNNING.deviceId,
        since: 1_000,
        credentialsRemoved: true,
      },
    });
    expect(shell.client.hostQuestions()).toEqual([]);
    // Whatever lists the questions hears it, so a revoked Host's go at once.
    expect(shell.changed).toHaveBeenCalled();
    await host.call(DecisionsLinkMethod.HOST_RUNTIME, { runtime: { state: "not-enrolled" } });
    expect(shell.client.hostQuestions()).toEqual([]);
  });

  it("keeps a list only when it was served to the owner this computer speaks as now", async () => {
    const { host, client } = await pair();
    answerAnnouncements(host);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() => expect(shell.client.runtimeOf(HOST)?.runtime).toEqual(RUNNING));
    await host.call(DecisionsLinkMethod.QUESTIONS_CHANGED, {
      hostId: QHOST,
      owner: SERVED,
      questions: [item(1)],
    });
    expect(shell.client.hostQuestions()[0]?.questions).toEqual([item(1)]);

    // The owner here changed: a list the Host served the earlier one, however late it lands, isn't the new one's.
    const other = { ...OWNER, installationId: "inst_owner_9876543210" };
    shell.setOwner(other);
    await host.call(DecisionsLinkMethod.QUESTIONS_CHANGED, {
      hostId: QHOST,
      owner: SERVED,
      questions: [item(2)],
    });
    expect(shell.client.hostQuestions()).toEqual([]);
    shell.setOwner(OWNER);
    expect(shell.client.hostQuestions()[0]?.questions).toEqual([item(1)]);

    // Served to the owner here, it counts the moment it lands.
    await host.call(DecisionsLinkMethod.QUESTIONS_CHANGED, {
      hostId: QHOST,
      owner: SERVED,
      questions: [item(3)],
    });
    expect(shell.client.hostQuestions()[0]?.questions).toEqual([item(3)]);
  });

  it("keeps a read of the new owner's list when the earlier owner's list lands while it is out", async () => {
    const { host, client } = await pair();
    const other = { ...OWNER, installationId: "inst_owner_9876543210" };
    let hold = false;
    let lists = 0;
    let reading!: () => void;
    const readStarted = new Promise<void>((resolve) => (reading = resolve));
    let release!: (list: unknown) => void;
    answerAnnouncements(
      host,
      () => RUNNING,
      () => {
        lists += 1;
        if (!hold) return { hostId: null, owner: null, questions: [] };
        reading();
        return new Promise((resolve) => (release = resolve));
      }
    );
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() => expect(shell.client.runtimeOf(HOST)?.runtime).toEqual(RUNNING));
    // The first owner's own read is answered before the hold goes on.
    await vi.waitFor(() => expect(lists).toBe(1));

    // The owner here changes and says so; the Host's list for it is held while the earlier one's lands.
    hold = true;
    shell.setOwner(other);
    shell.client.announceOwnerState();
    await readStarted;
    await host.call(DecisionsLinkMethod.QUESTIONS_CHANGED, {
      hostId: QHOST,
      owner: SERVED,
      questions: [item(1)],
    });
    release({
      hostId: QHOST,
      owner: { installationId: other.installationId, ownerDeviceId: other.ownerDeviceId },
      questions: [item(2)],
    });

    await vi.waitFor(() => expect(shell.client.hostQuestions()[0]?.questions).toEqual([item(2)]));
  });

  it("lets nothing a replaced link sends move the current link's list or its read", async () => {
    const old = await pair();
    answerAnnouncements(old.host);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, old.client);
    await vi.waitFor(() => expect(shell.client.runtimeOf(HOST)?.runtime).toEqual(RUNNING));

    // The newer link's read of its list is held until the older link has spoken.
    const newer = await pair();
    let answer!: (list: unknown) => void;
    const held = new Promise((resolve) => (answer = resolve));
    answerAnnouncements(
      newer.host,
      () => RUNNING,
      () => held
    );
    shell.open(HOST, newer.client);
    await vi.waitFor(() => expect(shell.client.runtimeOf(HOST)?.live).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await old.host.call(DecisionsLinkMethod.QUESTIONS_CHANGED, {
      hostId: QHOST,
      owner: SERVED,
      questions: [item(1)],
    });
    expect(shell.client.hostQuestions()).toEqual([]);

    answer({ hostId: QHOST, owner: SERVED, questions: [item(2)] });
    await vi.waitFor(() => expect(shell.client.hostQuestions()[0]?.questions).toEqual([item(2)]));
  });

  it("drops what a Host listed once it comes back as a build from before Host questions", async () => {
    const first = await pair();
    const decisions = questionHost();
    decisions.set({ hostId: QHOST, questions: [item(1)] });
    serveQuestions(first.host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, first.client);
    await vi.waitFor(() => expect(shell.client.hostQuestions()).toHaveLength(1));
    first.host.close("test");

    const older = await pair();
    answerAnnouncements(older.host, () => RUNNING, null);
    shell.changed.mockClear();
    shell.open(HOST, older.client);

    await vi.waitFor(() => expect(shell.client.hostQuestions()).toEqual([]));
    expect(shell.changed).toHaveBeenCalled();
  });

  it("keeps the current link's list when a link it replaced turns out to be from before Host questions", async () => {
    // The older link's Host takes its announcement only once the newer link has listed.
    const old = await pair();
    let announced!: () => void;
    const taking = new Promise<void>((resolve) => (announced = resolve));
    old.host.registerCallHandler(DecisionsLinkMethod.OWNER_STATE_V2, z.unknown(), async () => {
      await taking;
      return { runtime: RUNNING };
    });
    const calls = vi.spyOn(old.client, "call");
    const shell = shellOf([STUDIO]);
    shell.open(HOST, old.client);

    const newer = await pair();
    const decisions = questionHost();
    decisions.set({ hostId: QHOST, questions: [item(1)] });
    serveQuestions(newer.host, decisions);
    shell.open(HOST, newer.client);
    await vi.waitFor(() => expect(shell.client.hostQuestions()).toHaveLength(1));

    announced();
    await vi.waitFor(() =>
      expect(calls.mock.calls.map(([method]) => method)).toContain(DecisionsLinkMethod.QUESTIONS)
    );
    const read = calls.mock.results[
      calls.mock.calls.findIndex(([method]) => method === DecisionsLinkMethod.QUESTIONS)
    ]!.value as Promise<unknown>;
    await expect(read).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shell.client.hostQuestions()[0]?.questions).toEqual([item(1)]);
  });

  it("returns nothing it read to a session whose owner turned Decisions off meanwhile", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    decisions.set({ hostId: QHOST, questions: [item(1)] });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    decisions.answerWith(async (read) => {
      await held;
      return read.read === "content" ? { result: "read", question: content(read.reference) } : null;
    });
    serveQuestions(host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() => expect(shell.client.hostQuestions()).toHaveLength(1));

    const reading = shell.client.readHostQuestion(QHOST, {
      read: "content",
      reference: item(1).reference,
    });
    await vi.waitFor(() => expect(decisions.reads).toHaveLength(1));
    await client.call(DecisionsLinkMethod.OWNER_STATE_V2, { ...OWNER, enabled: false });
    finish();

    expect(await reading).toEqual({ ok: true, value: { result: "off" } });
  });

  it("carries what each question in Needs you asks, and pushes a change of ask alone (#17895)", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    const first = item(1).reference.questionId;
    const second = item(2).reference.questionId;
    decisions.set({
      hostId: QHOST,
      questions: [item(1), item(2)],
      asks: new Map([
        [first, null],
        [second, "msg_agent_0001"],
      ]),
    });
    serveQuestions(host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() =>
      expect(shell.client.hostQuestions()[0]?.asks).toEqual(
        new Map([
          [first, null],
          [second, "msg_agent_0001"],
        ])
      )
    );

    const pushes = vi.spyOn(host, "call");
    // The agent follows up on a question still open: nothing its v1 list says moves.
    decisions.set({
      hostId: QHOST,
      questions: [item(1), item(2)],
      asks: new Map([
        [first, "msg_agent_0002"],
        [second, "msg_agent_0001"],
      ]),
    });
    await vi.waitFor(() =>
      expect(shell.client.hostQuestions()[0]?.asks?.get(first)).toBe("msg_agent_0002")
    );
    expect(pushes.mock.calls.map(([method]) => method)).toEqual([
      DecisionsLinkMethod.QUESTIONS_CHANGED_V2,
    ]);
  });

  it("tells a Shell from before #17895 its list as v1, and nothing when only an ask moved", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    const first = item(1).reference.questionId;
    decisions.set({ hostId: QHOST, questions: [item(1)], asks: new Map([[first, null]]) });
    serveQuestions(host, decisions);
    const heard: unknown[] = [];
    client.registerCallHandler(DecisionsLinkMethod.QUESTIONS_CHANGED, z.unknown(), (payload) => {
      heard.push(payload);
      return null;
    });
    await client.call(DecisionsLinkMethod.OWNER_STATE_V2, OWNER);
    // Exactly the v1 shape an older Shell's strict read takes.
    expect(await client.call(DecisionsLinkMethod.QUESTIONS, { read: "list" })).toEqual({
      hostId: QHOST,
      owner: SERVED,
      questions: [item(1)],
    });

    decisions.set({
      hostId: QHOST,
      questions: [item(1)],
      asks: new Map([[first, "msg_agent_0001"]]),
    });
    const answered = item(1, { kind: "settled", outcome: "answered", handled: false });
    decisions.set({ hostId: QHOST, questions: [answered], asks: new Map() });
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0]).toEqual({ hostId: QHOST, owner: SERVED, questions: [answered] });
  });

  it("tells a Shell that reads the asks but can't take them pushed the list as it stands, as v1", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    const first = item(1).reference.questionId;
    decisions.set({ hostId: QHOST, questions: [item(1)], asks: new Map([[first, null]]) });
    serveQuestions(host, decisions);
    const heard: unknown[] = [];
    client.registerCallHandler(DecisionsLinkMethod.QUESTIONS_CHANGED, z.unknown(), (payload) => {
      heard.push(payload);
      return null;
    });
    await client.call(DecisionsLinkMethod.OWNER_STATE_V2, OWNER);
    await client.call(DecisionsLinkMethod.QUESTION_LIST_V2, {});

    // Its v2 push is refused: the same change is told again in the strict v1 shape.
    const answered = item(1, { kind: "settled", outcome: "answered", handled: false });
    decisions.set({ hostId: QHOST, questions: [answered], asks: new Map() });
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0]).toEqual({ hostId: QHOST, owner: SERVED, questions: [answered] });
  });

  it("keeps the list with its asks when a v1 push the Host sent before the read lands first", async () => {
    const { host, client } = await pair();
    const first = item(1).reference.questionId;
    host.registerCallHandler(DecisionsLinkMethod.OWNER_STATE_V2, z.unknown(), () => ({
      runtime: RUNNING,
    }));
    // As the read reaches it, the Host has just pushed a list from before it knew the Shell reads asks.
    host.registerCallHandler(DecisionsLinkMethod.QUESTION_LIST_V2, z.unknown(), async () => {
      await host.call(DecisionsLinkMethod.QUESTIONS_CHANGED, {
        hostId: QHOST,
        owner: SERVED,
        questions: [item(1)],
      });
      return {
        hostId: QHOST,
        owner: SERVED,
        questions: [item(1)],
        asks: [{ questionId: first, ask: "msg_agent_0002" }],
      };
    });
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() =>
      expect(shell.client.hostQuestions()[0]?.asks?.get(first)).toBe("msg_agent_0002")
    );
  });

  it("reads a Host from before #17895 without asks, asking for them once per link", async () => {
    const { host, client } = await pair();
    answerAnnouncements(
      host,
      () => RUNNING,
      () => ({ hostId: QHOST, owner: SERVED, questions: [item(1)] })
    );
    const calls = vi.spyOn(client, "call");
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() => expect(shell.client.hostQuestions()[0]?.questions).toEqual([item(1)]));
    expect(shell.client.hostQuestions()[0]?.asks).toBeUndefined();

    shell.client.announceOwnerState();
    await vi.waitFor(() =>
      expect(
        calls.mock.calls.filter(([method]) => method === DecisionsLinkMethod.QUESTIONS)
      ).toHaveLength(2)
    );
    expect(
      calls.mock.calls.filter(([method]) => method === DecisionsLinkMethod.QUESTION_LIST_V2)
    ).toHaveLength(1);
  });

  it("reads a thread whose messages say where they were sent and whether delivery stopped", async () => {
    const { host, client } = await pair();
    const decisions = questionHost();
    decisions.set({ hostId: QHOST, questions: [item(1)] });
    const sentAt = "2026-11-02T10:03:00.000Z";
    const thread = [
      {
        type: "message" as const,
        messageId: "msg_agent_0001",
        from: "agent" as const,
        text: "Which branch?",
        images: [],
        expectsReply: true,
        onComputer: false,
        sentAt,
        deliveryStatus: null,
        deliveryStopped: false,
        unreadable: false,
      },
      {
        type: "message" as const,
        messageId: "msg_person_0001",
        from: "person" as const,
        text: "main",
        images: [],
        expectsReply: false,
        onComputer: true,
        sentAt,
        deliveryStatus: "terminal-delivered" as const,
        deliveryStopped: true,
        unreadable: false,
      },
    ];
    decisions.answerWith((read) =>
      read.read === "content"
        ? { result: "read", question: { ...content(read.reference), thread } }
        : null
    );
    serveQuestions(host, decisions);
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() => expect(shell.client.hostQuestions()).toHaveLength(1));

    const read = await shell.client.readHostQuestion(QHOST, {
      read: "content",
      reference: item(1).reference,
    });
    expect(read?.ok && read.value.result === "read" ? read.value.question.thread : read).toEqual(
      thread
    );
  });

  it("asks a Host from before Host questions once per link, and lists none of its questions", async () => {
    const { host, client } = await pair();
    // A Host from before #17230: it hears the owner, and knows nothing of questions.
    host.registerCallHandler(DecisionsLinkMethod.OWNER_STATE_V2, z.unknown(), () => ({
      runtime: RUNNING,
    }));
    const calls = vi.spyOn(client, "call");
    const shell = shellOf([STUDIO]);
    shell.open(HOST, client);
    await vi.waitFor(() =>
      expect(calls.mock.calls.map(([method]) => method)).toContain(DecisionsLinkMethod.QUESTIONS)
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    shell.client.announceOwnerState();
    await vi.waitFor(() =>
      expect(
        calls.mock.calls.filter(([method]) => method === DecisionsLinkMethod.OWNER_STATE_V2)
      ).toHaveLength(2)
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      calls.mock.calls.filter(([method]) => method === DecisionsLinkMethod.QUESTIONS)
    ).toHaveLength(1);
    expect(shell.client.hostQuestions()).toEqual([]);
  });
});
