import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@daintreehq/decisions-protocol";
import type {
  DecisionsHostLink,
  DecisionsHostsPort,
  HostAcceptResult,
  HostCallOutcome,
  HostIdentityReport,
  HostRequestResult,
} from "../../../types/decisionsHosts.js";
import type { DecisionsRelayRequestFailure } from "../../../../shared/types/decisions.js";
import type { DecisionsHostRuntimeObservation } from "../../../../shared/types/decisionsHosts.js";
import { HostEnroller, type HostEnrollerOwner } from "../hostEnrollment.js";
import { HostRecords } from "../hostEnrollmentRecords.js";

const INSTALLATION = "inst_owner_0123456789";
const OWNER_DEVICE = "dev_owner_desktop_01";
const SIGNING = "S".repeat(87);
const EXCHANGE = "E".repeat(87);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every queued promise step run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type Step<T> = () => Promise<HostCallOutcome<T>>;

/** One Host session, answering as told; it records every step asked of it. */
class FakeLink implements DecisionsHostLink {
  isOpen = true;
  readonly asked: string[] = [];
  readonly requests: Array<{ attempt: string; label: string; replace?: string }> = [];
  readonly accepts: Array<{ attempt: string; response: string }> = [];
  private readonly closeListeners = new Set<() => void>();
  holds = 0;
  identity: HostIdentityReport = { kind: "none" };
  onStatus: Step<HostIdentityReport> = async () => ({ ok: true, value: this.identity });
  onRequest: Step<HostRequestResult> = async () => ({
    ok: true,
    value: { step: "requested", request: "decisions-host-request.v1.fake" },
  });
  onAccept: Step<HostAcceptResult> = async () => {
    // The relay registered it before the Host accepted.
    owner?.relayDevices.push(device(this.nextDeviceId));
    this.identity = hostIdentity(this.nextDeviceId);
    return { ok: true, value: { step: "accepted", deviceId: this.nextDeviceId } };
  };

  constructor(public nextDeviceId = "dev_host_000000001") {}

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  hold(): () => void {
    this.holds += 1;
    return () => {
      this.holds -= 1;
    };
  }

  close(): void {
    this.isOpen = false;
    for (const listener of this.closeListeners) listener();
  }

  status() {
    this.asked.push("status");
    return this.onStatus();
  }

  request(input: { attempt: string; label: string; replace?: string }) {
    this.asked.push("request");
    this.requests.push(input);
    return this.onRequest();
  }

  accept(input: { attempt: string; response: string }) {
    this.asked.push("accept");
    this.accepts.push(input);
    return this.onAccept();
  }
}

function hostIdentity(deviceId: string, overrides: Partial<HostIdentityReport> = {}) {
  return {
    kind: "host",
    relayOrigin: "https://decisions.example.workers.dev",
    installationId: INSTALLATION,
    deviceId,
    ownerDeviceId: OWNER_DEVICE,
    signingPub: SIGNING,
    exchangePub: EXCHANGE,
    ...overrides,
  } as HostIdentityReport;
}

function device(deviceId: string, revoked = false): DeviceInfo {
  return {
    device_id: deviceId,
    role: "desktop-host",
    label: "studio",
    cert: { role: "desktop-host", signing_pub: SIGNING, exchange_pub: EXCHANGE },
    created_at: new Date().toISOString(),
    last_seen_at: null,
    revoked_at: revoked ? new Date().toISOString() : null,
    push_enabled: false,
  } as unknown as DeviceInfo;
}

class FakePort implements DecisionsHostsPort {
  readonly entries: Array<{ hostId: string; name: string }> = [];
  readonly links = new Map<string, FakeLink>();
  private readonly opened = new Set<(hostId: string, link: DecisionsHostLink) => void>();

  hosts() {
    return this.entries;
  }

  linkFor(hostId: string) {
    const link = this.links.get(hostId);
    return link?.isOpen ? link : null;
  }

  onLinkOpened(listener: (hostId: string, link: DecisionsHostLink) => void) {
    this.opened.add(listener);
    return () => this.opened.delete(listener);
  }

  onHostsChanged() {
    return () => {};
  }

  /** What each Host last reported of its own Decisions (#16022). */
  readonly runtimes = new Map<string, DecisionsHostRuntimeObservation>();

  runtimeOf(hostId: string) {
    return this.runtimes.get(hostId) ?? null;
  }

  announceOwnerState() {}

  /** The host's link comes up, as the Remote Hosts client says it. */
  connect(hostId: string, link = new FakeLink()): FakeLink {
    if (!this.entries.some((entry) => entry.hostId === hostId)) {
      this.entries.push({ hostId, name: hostId });
    }
    this.links.get(hostId)?.close();
    this.links.set(hostId, link);
    for (const listener of this.opened) listener(hostId, link);
    return link;
  }
}

function memoryMeta() {
  const values = new Map<string, string>();
  return {
    values,
    getMeta: vi.fn(async (key: string) => values.get(key) ?? null),
    setMeta: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

let port: FakePort;
let owner: (HostEnrollerOwner & { relayDevices: DeviceInfo[] }) | null;
let autoEnroll: boolean;
let changed: number;
let enroller: HostEnroller;
let enroll: ReturnType<
  typeof vi.fn<(request: string) => Promise<{ response: string } | DecisionsRelayRequestFailure>>
>;
let meta: ReturnType<typeof memoryMeta>;
let watched: ReturnType<typeof vi.fn<(watcher: unknown) => void>>;

function makeOwner(connected: boolean) {
  const relayDevices: DeviceInfo[] = [];
  return {
    key: `origin\n${INSTALLATION}\n${OWNER_DEVICE}`,
    installationId: INSTALLATION,
    deviceId: OWNER_DEVICE,
    connected,
    records: new HostRecords(meta, INSTALLATION),
    relayDevices,
    devices: vi.fn(async () => relayDevices),
    enroll,
  };
}

let attempts = 0;

/** The relay revokes a device, as Devices or any other route would. */
function revokeOnRelay(deviceId: string): void {
  const row = owner!.relayDevices.find((entry) => entry.device_id === deviceId);
  if (row) (row as { revoked_at: string | null }).revoked_at = new Date().toISOString();
  else owner!.relayDevices.push(device(deviceId, true));
}

beforeEach(() => {
  port = new FakePort();
  meta = memoryMeta();
  autoEnroll = true;
  changed = 0;
  attempts = 0;
  enroll = vi.fn(async () => ({ response: "decisions-host-enrollment.v1.fake" }));
  owner = makeOwner(true);
  watched = vi.fn<(watcher: unknown) => void>();
  enroller = new HostEnroller({
    watchPort: (watcher) => {
      watched(watcher);
      watcher(port);
      return () => watcher(null);
    },
    owner: () => owner,
    autoEnroll: () => autoEnroll,
    onChanged: () => {
      changed += 1;
    },
    newAttemptId: () => `attempt_${String(++attempts).padStart(10, "0")}`,
  });
});

async function stateOf(hostId: string) {
  const listed = await enroller.list();
  if (listed.result !== "listed") throw new Error(listed.result);
  return listed.hosts.find((host) => host.hostId === hostId)?.enrollment;
}

describe("HostEnroller", () => {
  it("enrolls a Host when its link comes up while Decisions is connected", async () => {
    enroller.start();
    const link = port.connect("studio");
    await settle();

    expect(link.asked).toEqual(["status", "request", "accept"]);
    expect(link.requests[0]).toMatchObject({ label: "studio" });
    expect(link.requests[0].replace).toBeUndefined();
    expect(enroll).toHaveBeenCalledWith("decisions-host-request.v1.fake");
    // The Host is handed exactly what the relay registered, for the attempt it made keys for.
    expect(link.accepts).toEqual([
      { attempt: link.requests[0].attempt, response: "decisions-host-enrollment.v1.fake" },
    ]);
    expect(await stateOf("studio")).toEqual({ state: "enrolled", deviceId: "dev_host_000000001" });
    expect(await owner!.records!.get("studio")).toMatchObject({
      deviceId: "dev_host_000000001",
      revokedAt: null,
    });
    // The connection was held for the run and let go after.
    expect(link.holds).toBe(0);
    expect(changed).toBeGreaterThan(0);
  });

  it("waits for Decisions to connect, then enrolls every Host already connected", async () => {
    owner = makeOwner(false);
    enroller.start();
    const first = port.connect("studio");
    const second = port.connect("lab");
    await settle();
    expect(first.asked).toEqual([]);
    expect(await stateOf("studio")).toEqual({ state: "unchecked" });

    // Setup finished and the relay connected.
    owner = { ...owner!, connected: true };
    enroller.sweep();
    await settle();
    expect(first.asked).toEqual(["status", "request", "accept"]);
    expect(second.asked).toEqual(["status", "request", "accept"]);
  });

  it("enrolls nothing with automatic enrollment off, and offers Enroll instead", async () => {
    autoEnroll = false;
    enroller.start();
    const link = port.connect("studio");
    await settle();

    expect(link.asked).toEqual(["status"]);
    expect(enroll).not.toHaveBeenCalled();
    const listed = await enroller.list();
    expect(listed).toMatchObject({
      result: "listed",
      autoEnroll: false,
      hosts: [
        {
          hostId: "studio",
          connected: true,
          enrollment: { state: "not-enrolled" },
          canEnroll: true,
        },
      ],
    });

    const done = await enroller.enroll("studio");
    expect(done).toMatchObject({
      result: "done",
      host: { enrollment: { state: "enrolled", deviceId: "dev_host_000000001" }, canEnroll: false },
    });
    expect(link.asked).toEqual(["status", "status", "request", "accept"]);
  });

  it("enrolls a connected Host once automatic enrollment is turned back on", async () => {
    autoEnroll = false;
    enroller.start();
    const link = port.connect("studio");
    await settle();
    expect(link.asked).toEqual(["status"]);

    autoEnroll = true;
    enroller.sweep();
    await settle();
    expect(link.asked).toEqual(["status", "status", "request", "accept"]);
  });

  it("enrolls nothing from a Shell that isn't a Decisions owner", async () => {
    owner = null;
    enroller.start();
    const link = port.connect("studio");
    enroller.sweep();
    await settle();

    expect(link.asked).toEqual([]);
    expect(link.holds).toBe(0);
    expect(await enroller.list()).toEqual({ result: "not-set-up" });
    expect(await enroller.enroll("studio")).toEqual({ result: "not-set-up" });
    expect(link.asked).toEqual([]);
  });

  it("leaves a Host enrolled already alone, and another relay's or its own setup untouched", async () => {
    enroller.start();
    owner!.relayDevices.push(device("dev_host_enrolled_1"));
    const enrolled = new FakeLink();
    enrolled.identity = hostIdentity("dev_host_enrolled_1");
    port.connect("studio", enrolled);
    const elsewhere = new FakeLink();
    elsewhere.identity = hostIdentity("dev_other_00000001", {
      installationId: "inst_other_0000001",
    });
    port.connect("lab", elsewhere);
    const own = new FakeLink();
    own.identity = { kind: "owner" };
    port.connect("desk", own);
    await settle();

    expect(enrolled.asked).toEqual(["status"]);
    expect(elsewhere.asked).toEqual(["status"]);
    expect(own.asked).toEqual(["status"]);
    expect(await stateOf("studio")).toEqual({ state: "enrolled", deviceId: "dev_host_enrolled_1" });
    expect(await stateOf("lab")).toEqual({ state: "other-setup" });
    expect(await stateOf("desk")).toEqual({ state: "own-setup" });
    // Enroll isn't offered for either, and does nothing if asked.
    const listed = await enroller.list();
    expect(listed.result === "listed" && listed.hosts.every((host) => !host.canEnroll)).toBe(true);
    await enroller.enroll("lab");
    expect(elsewhere.asked).not.toContain("request");
  });

  it("shows a Host that refuses as failed, while the next Host enrolls without waiting for a slow one", async () => {
    enroller.start();
    const refusing = new FakeLink();
    refusing.onRequest = async () => ({
      ok: true,
      value: { step: "refused", reason: "no-keychain", detail: "No keyring is available" },
    });
    port.connect("refusing", refusing);
    const slow = new FakeLink();
    const slowStatus = deferred<HostCallOutcome<HostIdentityReport>>();
    slow.onStatus = () => slowStatus.promise;
    port.connect("slow", slow);
    const fine = port.connect("fine");
    await settle();

    expect(enroll).toHaveBeenCalledTimes(1);
    expect(fine.asked).toEqual(["status", "request", "accept"]);
    expect(await stateOf("refusing")).toMatchObject({
      state: "failed",
      failure: { reason: "no-keychain", detail: "No keyring is available" },
    });
    expect(await stateOf("slow")).toEqual({ state: "checking" });
    slowStatus.resolve({ ok: true, value: { kind: "none" } });
    await settle();
    expect(await stateOf("slow")).toMatchObject({ state: "enrolled" });
  });

  it("tries a failed Host again only on its next connection, never on its own", async () => {
    enroller.start();
    enroll.mockResolvedValueOnce({
      result: "unreachable",
      origin: "https://decisions.example.workers.dev",
      reason: "network",
    });
    const first = port.connect("studio");
    await settle();
    expect(await stateOf("studio")).toMatchObject({
      state: "failed",
      failure: { reason: "relay-unreachable" },
    });

    // Decisions reconnecting, Settings reading, the switch flipping: none of it retries.
    enroller.sweep();
    enroller.sweep();
    await enroller.list();
    await enroller.observeDevices([]);
    await settle();
    expect(first.asked).toEqual(["status", "request"]);
    expect(enroll).toHaveBeenCalledTimes(1);

    const second = port.connect("studio");
    await settle();
    expect(second.asked).toEqual(["status", "request", "accept"]);
    expect(await stateOf("studio")).toMatchObject({ state: "enrolled" });
  });

  it("says a Host needs updating when it doesn't know enrollment", async () => {
    enroller.start();
    const old = new FakeLink();
    old.onStatus = async () => ({ ok: false, failure: "needs-update" });
    port.connect("studio", old);
    await settle();
    expect(await stateOf("studio")).toEqual({ state: "needs-update" });
    const listed = await enroller.list();
    expect(listed.result === "listed" && listed.hosts[0].canEnroll).toBe(false);
  });

  it("never enrolls a revoked Host automatically again, until Enroll does it and clears the record", async () => {
    enroller.start();
    const first = port.connect("studio");
    await settle();
    expect(await stateOf("studio")).toMatchObject({ state: "enrolled" });

    // Revoked from Devices, by whatever route; the next list read sees it.
    revokeOnRelay("dev_host_000000001");
    await enroller.observeDevices(owner!.relayDevices);
    expect((await owner!.records!.get("studio"))?.revokedAt).toEqual(expect.any(Number));
    expect(await stateOf("studio")).toEqual({ state: "revoked" });

    // It reconnects having let its identity go: still never automatically.
    const second = new FakeLink("dev_host_000000002");
    port.connect("studio", second);
    await settle();
    expect(second.asked).toEqual(["status"]);
    expect(await stateOf("studio")).toEqual({ state: "revoked" });
    first.close();

    // A restart keeps the record: a fresh enroller reading the same store agrees.
    const restarted = new HostEnroller({
      watchPort: (watcher) => {
        watcher(port);
        return () => {};
      },
      owner: () => owner,
      autoEnroll: () => true,
      onChanged: () => {},
    });
    restarted.start();
    const third = new FakeLink("dev_host_000000003");
    port.connect("studio", third);
    await settle();
    expect(third.asked.filter((step) => step !== "status")).toEqual([]);
    restarted.stop();

    expect(await enroller.enroll("studio")).toMatchObject({
      result: "done",
      host: { enrollment: { state: "enrolled", deviceId: "dev_host_000000003" } },
    });
    expect(await owner!.records!.get("studio")).toMatchObject({
      deviceId: "dev_host_000000003",
      revokedAt: null,
    });
  });

  it("sees a Host still holding its revoked identity as revoked, and Enroll replaces exactly that one", async () => {
    enroller.start();
    revokeOnRelay("dev_host_revoked_01");
    const link = new FakeLink("dev_host_000000009");
    link.identity = hostIdentity("dev_host_revoked_01");
    port.connect("studio", link);
    await settle();

    expect(link.asked).toEqual(["status"]);
    expect(await stateOf("studio")).toEqual({ state: "revoked" });
    expect((await owner!.records!.get("studio"))?.revokedAt).toEqual(expect.any(Number));

    await enroller.enroll("studio");
    expect(link.requests.at(-1)?.replace).toBe("dev_host_revoked_01");
    expect(await stateOf("studio")).toEqual({ state: "enrolled", deviceId: "dev_host_000000009" });
  });

  it("writes nothing once stopped, even for a run already past the relay", async () => {
    enroller.start();
    const link = new FakeLink();
    const accepting = deferred<HostCallOutcome<HostAcceptResult>>();
    link.onAccept = () => accepting.promise;
    port.connect("studio", link);
    await settle();
    expect(link.asked).toEqual(["status", "request", "accept"]);

    enroller.stop();
    accepting.resolve({ ok: true, value: { step: "accepted", deviceId: "dev_host_000000001" } });
    await settle();
    expect(meta.setMeta).not.toHaveBeenCalled();
    expect(link.holds).toBe(0);
  });

  it("keeps a Host's run to itself: Enroll during an automatic attempt waits, and asks again", async () => {
    enroller.start();
    const link = new FakeLink();
    const status = deferred<HostCallOutcome<HostIdentityReport>>();
    link.onStatus = () => status.promise;
    port.connect("studio", link);
    await settle();
    const manual = enroller.enroll("studio");
    await settle();
    expect(link.asked).toEqual(["status"]);
    status.resolve({ ok: true, value: { kind: "none" } });
    link.onStatus = async () => ({ ok: true, value: link.identity });
    await manual;
    // The automatic run enrolled it; Enroll found it enrolled and asked nothing more of the relay.
    expect(enroll).toHaveBeenCalledTimes(1);
    expect(link.asked).toEqual(["status", "request", "accept", "status"]);
  });
  it("gives a link that comes up while its Host's last run is in flight its own attempt after", async () => {
    enroller.start();
    const first = new FakeLink();
    const registering = deferred<{ response: string } | DecisionsRelayRequestFailure>();
    enroll.mockImplementationOnce(() => registering.promise);
    port.connect("studio", first);
    await settle();
    expect(first.asked).toEqual(["status", "request"]);

    // The link drops and comes back while the relay is still answering.
    const second = port.connect("studio");
    await settle();
    expect(second.asked).toEqual([]);
    registering.resolve({ response: "decisions-host-enrollment.v1.fake" });
    await settle();
    expect(first.asked).toEqual(["status", "request"]);
    expect(second.asked).toEqual(["status", "request", "accept"]);
    expect(await stateOf("studio")).toMatchObject({ state: "enrolled" });
  });

  it("drops an Enroll still waiting its turn when Decisions stops or the owner changes", async () => {
    enroller.start();
    const link = new FakeLink();
    const status = deferred<HostCallOutcome<HostIdentityReport>>();
    link.onStatus = () => status.promise;
    port.connect("studio", link);
    await settle();
    const manual = enroller.enroll("studio");
    await settle();

    enroller.forget();
    owner = { ...makeOwner(true), key: "another-owner" };
    status.resolve({ ok: true, value: { kind: "none" } });
    await manual;
    await settle();
    expect(link.asked).toEqual(["status"]);
    expect(enroll).not.toHaveBeenCalled();
  });

  it("registers nothing automatically for a Host revoked while it made its keys", async () => {
    enroller.start();
    const first = port.connect("studio");
    await settle();
    expect(await stateOf("studio")).toMatchObject({ state: "enrolled" });
    enroll.mockClear();

    // It reconnects having lost its identity; while it makes new keys, Devices revokes its old device.
    const second = new FakeLink("dev_host_000000002");
    const requesting = deferred<HostCallOutcome<HostRequestResult>>();
    second.onRequest = () => requesting.promise;
    first.close();
    port.connect("studio", second);
    await settle();
    expect(second.asked).toEqual(["status", "request"]);
    revokeOnRelay("dev_host_000000001");
    await enroller.observeDevices(owner!.relayDevices);
    requesting.resolve({
      ok: true,
      value: { step: "requested", request: "decisions-host-request.v1.fake" },
    });
    await settle();

    expect(enroll).not.toHaveBeenCalled();
    expect(second.asked).toEqual(["status", "request"]);
    expect(await stateOf("studio")).toEqual({ state: "revoked" });
    expect((await owner!.records!.get("studio"))?.revokedAt).toEqual(expect.any(Number));
  });

  it("shows what an enrolled Host last reported of its own Decisions beside its enrollment", async () => {
    enroller.start();
    port.connect("studio");
    await settle();
    port.runtimes.set("studio", {
      runtime: { state: "running", deviceId: "dev_host_000000001", connection: "connected" },
      at: 1_000,
      live: true,
    });

    const listed = await enroller.list();
    expect(listed).toMatchObject({
      result: "listed",
      hosts: [
        {
          hostId: "studio",
          enrollment: { state: "enrolled" },
          runtime: {
            runtime: { state: "running", connection: "connected" },
            at: 1_000,
            live: true,
          },
        },
      ],
    });
  });
});
