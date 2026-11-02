import { RelayError } from "@daintreehq/decisions-client";
import type { DeviceInfo } from "@daintreehq/decisions-protocol";
import { newId } from "@daintreehq/decisions-crypto";
import type { DecisionsRelayRequestFailure } from "../../../shared/types/decisions.js";
import type {
  DecisionsHost,
  DecisionsHostEnrollment,
  DecisionsHostEnrollResult,
  DecisionsHostFailure,
  DecisionsHostFailureReason,
  DecisionsHostsResult,
} from "../../../shared/types/decisionsHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  boundedDetail,
  type DecisionsHostLink,
  type DecisionsHostsPort,
  type HostCallOutcome,
  type HostEnrollRefusal,
} from "../../types/decisionsHosts.js";
import type { HostRecord, HostRecords } from "./hostEnrollmentRecords.js";

/** The protocol's longest device label; a longer host name is cut to it. */
const MAX_LABEL_LENGTH = 60;

/** This computer as the owner that enrolls, while it is one. */
export interface HostEnrollerOwner {
  /** Changes with the owner identity: what was done for one is nothing to the next. */
  key: string;
  installationId: string;
  deviceId: string;
  /** Decisions is connected to the relay now. Only then is anything enrolled automatically. */
  connected: boolean;
  /** Its record of Hosts; null while its store isn't open. */
  records: HostRecords | null;
  /** The relay's devices whose certificates verify, revoked ones included. */
  devices(): Promise<DeviceInfo[] | DecisionsRelayRequestFailure>;
  /**
   * Issues a `desktop-host` certificate and grant for the Host's request and
   * registers them with the relay, answering the signed enrollment for the
   * Host. Throws what the library refused with.
   */
  enroll(request: string): Promise<{ response: string } | DecisionsRelayRequestFailure>;
}

export interface HostEnrollerOptions {
  /** Calls the watcher with the Remote Hosts port now and whenever it comes or goes. */
  watchPort(watcher: (port: DecisionsHostsPort | null) => void): () => void;
  /** The owner now; null while Decisions has no owner identity here (off, not set up, revoked). */
  owner(): HostEnrollerOwner | null;
  autoEnroll(): boolean;
  /** Something Settings shows of the Hosts changed. */
  onChanged(): void;
  now?: () => number;
  newAttemptId?: () => string;
}

type Mode = "auto" | "manual";

interface HostView {
  /** The owner it was observed for. */
  key: string;
  enrollment: DecisionsHostEnrollment;
}

/** Why a run stopped short of what it was doing: the lifetime, owner, link or setting moved. */
class Superseded extends Error {}

const ENROLLABLE = new Set<DecisionsHostEnrollment["state"]>([
  "unchecked",
  "not-enrolled",
  "revoked",
  "stale",
  "failed",
]);

function failure(
  reason: DecisionsHostFailureReason,
  at: number,
  detail?: string
): DecisionsHostEnrollment {
  const bounded = boundedDetail(detail);
  const value: DecisionsHostFailure =
    bounded === undefined ? { reason, at } : { reason, detail: bounded, at };
  return { state: "failed", failure: value };
}

function isRelayFailure(value: unknown): value is DecisionsRelayRequestFailure {
  return typeof value === "object" && value !== null && "result" in value;
}

/**
 * Enrolls the Remote Hosts this computer connects to as Decisions devices,
 * while it is the owner (#16021). Each Host gets its own keys, made on the
 * Host; this computer issues their certificate and grant and registers them
 * with the relay, so a Host keeps serving its own panes while this computer
 * sleeps.
 *
 * Automatically, a Host is enrolled when its link comes up while Decisions is
 * connected, and every connected one when Decisions connects (setup
 * finishing among those). Each link gets one automatic attempt: a failure
 * waits for the Host's next connection, whatever else happens meanwhile.
 * A Host whose device was seen revoked is never enrolled automatically again;
 * Enroll does it, and clears that once it succeeds. Each Host runs on its own,
 * one run at a time, so a slow or failing one holds up none of the rest.
 */
export class HostEnroller {
  private readonly now: () => number;
  private readonly newAttemptId: () => string;
  private port: DecisionsHostsPort | null = null;
  private offPort: (() => void) | null = null;
  private offPortEvents: Array<() => void> = [];
  private active = false;
  private disposed = false;
  /** Moves with every stop and forget, so a run that started before writes nothing after. */
  private generation = 0;
  /** The owner each link had its automatic attempt for. */
  private readonly attempted = new WeakMap<DecisionsHostLink, string>();
  private readonly views = new Map<string, HostView>();
  private readonly runs = new Map<string, Promise<void>>();

  constructor(private readonly options: HostEnrollerOptions) {
    this.now = options.now ?? Date.now;
    this.newAttemptId = options.newAttemptId ?? (() => newId());
  }

  /** Begins watching for Hosts; enrolls only once the owner is connected. Idempotent. */
  start(): void {
    if (this.active || this.disposed) return;
    this.active = true;
    this.offPort = this.options.watchPort((port) => this.usePort(port));
  }

  /** Stops watching and lets every run in flight go unfinished, writing nothing more. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.offPort?.();
    this.offPort = null;
    this.usePort(null);
    this.views.clear();
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  /**
   * The owner identity changed, or its data was deleted: what was observed
   * for it is dropped, and runs in flight write nothing more.
   */
  forget(): void {
    this.generation += 1;
    this.views.clear();
    this.options.onChanged();
  }

  /** Decisions connected, or automatic enrollment was turned on: every connected Host is offered its attempt. */
  sweep(): void {
    const port = this.port;
    if (!this.active || port === null) return;
    for (const { hostId } of port.hosts()) {
      const link = port.linkFor(hostId);
      if (link) this.maybeAuto(hostId, link);
    }
  }

  /** What Settings shows: every connected Host, and every one recorded as enrolled or revoked. */
  async list(): Promise<DecisionsHostsResult> {
    const owner = this.options.owner();
    if (owner === null) return { result: "not-set-up" };
    let records = new Map<string, HostRecord>();
    try {
      if (owner.records) records = await owner.records.read();
    } catch {
      // Shown without them; a run says what stopped it.
    }
    const hosts: DecisionsHost[] = [];
    for (const { hostId, name } of this.port?.hosts() ?? []) {
      const row = this.rowOf(owner, hostId, name, records.get(hostId) ?? null);
      if (row) hosts.push(row);
    }
    return { result: "listed", autoEnroll: this.options.autoEnroll(), hosts };
  }

  /** Enroll, from Settings: one attempt now, after any already running for that Host. */
  async enroll(hostId: string): Promise<DecisionsHostEnrollResult> {
    const owner = this.options.owner();
    if (owner === null || !this.active) return { result: "not-set-up" };
    const link = this.port?.linkFor(hostId) ?? null;
    if (link === null) return { result: "not-connected" };
    await this.queueRun(hostId, link, "manual");
    const after = this.options.owner();
    if (after === null) return { result: "not-set-up" };
    let record: HostRecord | null;
    try {
      record = (await after.records?.get(hostId)) ?? null;
    } catch {
      record = null;
    }
    const entry = this.port?.hosts().find((host) => host.hostId === hostId);
    const row = this.rowOf(after, hostId, entry?.name ?? hostId, record, true);
    return row ? { result: "done", host: row } : { result: "not-connected" };
  }

  /**
   * The relay's devices as a Devices read saw them, revoked ones included: a
   * Host whose recorded device was revoked, by whatever route, is recorded so.
   */
  async observeDevices(devices: readonly DeviceInfo[]): Promise<void> {
    const owner = this.options.owner();
    if (owner === null || owner.records === null) return;
    const generation = this.generation;
    const revoked = new Set(devices.filter((d) => d.revoked_at !== null).map((d) => d.device_id));
    if (revoked.size === 0) return;
    let changed = false;
    try {
      for (const [hostId, record] of await owner.records.read()) {
        if (record.deviceId === null || record.revokedAt !== null) continue;
        if (!revoked.has(record.deviceId)) continue;
        if (generation !== this.generation) return;
        const marked = await owner.records.markRevoked(hostId, record.deviceId, this.now());
        // Another device replaced it since the read: that one stands.
        if (marked === null) continue;
        const view = this.views.get(hostId);
        if (view?.key === owner.key && generation === this.generation) {
          this.views.set(hostId, { key: owner.key, enrollment: { state: "revoked" } });
        }
        changed = true;
      }
    } catch (error) {
      console.warn("[Decisions] A Host's revocation couldn't be recorded:", error);
    }
    if (changed) this.options.onChanged();
  }

  private usePort(port: DecisionsHostsPort | null): void {
    for (const off of this.offPortEvents) off();
    this.offPortEvents = [];
    this.port = this.active ? port : null;
    if (this.port === null) return;
    const current = this.port;
    this.offPortEvents = [
      current.onLinkOpened((hostId, link) => {
        this.maybeAuto(hostId, link);
        this.options.onChanged();
      }),
      current.onHostsChanged(() => this.options.onChanged()),
    ];
    this.sweep();
    this.options.onChanged();
  }

  private maybeAuto(hostId: string, link: DecisionsHostLink): void {
    // A run in flight for the Host's previous link doesn't take this one's
    // attempt: it waits its turn behind it.
    if (!this.active || !link.isOpen) return;
    const owner = this.options.owner();
    if (owner === null || !owner.connected) return;
    if (this.attempted.get(link) === owner.key) return;
    this.attempted.set(link, owner.key);
    void this.queueRun(hostId, link, "auto");
  }

  /** Runs after whatever already runs for the Host, so one Host never runs two at once. */
  private queueRun(hostId: string, link: DecisionsHostLink, mode: Mode): Promise<void> {
    const before = this.runs.get(hostId) ?? Promise.resolve();
    // Asked for this lifetime and owner: a stop, a forget or another identity
    // while it waits its turn drops it unrun.
    const generation = this.generation;
    const ownerKey = this.options.owner()?.key ?? null;
    const run = before
      .then(() => {
        if (generation !== this.generation || this.options.owner()?.key !== ownerKey) return;
        return this.run(hostId, link, mode);
      })
      .catch((error: unknown) => {
        if (!(error instanceof Superseded)) {
          console.warn("[Decisions] Enrolling a Remote Host stopped unexpectedly:", error);
        }
      });
    this.runs.set(hostId, run);
    void run.finally(() => {
      if (this.runs.get(hostId) === run) this.runs.delete(hostId);
      this.options.onChanged();
    });
    return run;
  }

  private async run(hostId: string, link: DecisionsHostLink, mode: Mode): Promise<void> {
    const owner = this.options.owner();
    if (owner === null || !this.active || !link.isOpen) return;
    const generation = this.generation;
    const live = (): boolean =>
      this.active &&
      generation === this.generation &&
      link.isOpen &&
      this.options.owner()?.key === owner.key;
    const show = (enrollment: DecisionsHostEnrollment): void => {
      if (generation !== this.generation) throw new Superseded();
      this.views.set(hostId, { key: owner.key, enrollment });
      this.options.onChanged();
    };
    const check = (): void => {
      if (!live()) throw new Superseded();
    };
    const before = this.views.get(hostId);
    const release = link.hold();
    try {
      show({ state: "checking" });
      const status = await link.status();
      check();
      if (!status.ok) return show(this.callFailure(status));
      const identity = status.value;
      if (identity.kind === "owner") return show({ state: "own-setup" });
      if (identity.kind === "unreadable") {
        return show(failure("host-keys-unreadable", this.now(), identity.detail));
      }
      const records = owner.records;
      if (records === null) return show(failure("records-unavailable", this.now()));
      let record: HostRecord | null;
      try {
        record = await records.get(hostId);
      } catch (error) {
        return show(failure("records-unavailable", this.now(), formatErrorMessage(error, "")));
      }
      check();
      const mine =
        identity.kind === "host" &&
        identity.installationId === owner.installationId &&
        identity.ownerDeviceId === owner.deviceId;
      let devices: DeviceInfo[] = [];
      if (mine || record?.deviceId) {
        const listed = await owner.devices();
        check();
        if (isRelayFailure(listed)) return show(this.relayFailure(listed));
        devices = listed;
      }
      const revokedIds = new Set(
        devices.filter((d) => d.revoked_at !== null).map((d) => d.device_id)
      );
      const seenRevoked =
        mine && revokedIds.has(identity.deviceId)
          ? identity.deviceId
          : record?.deviceId && revokedIds.has(record.deviceId)
            ? record.deviceId
            : null;
      if (seenRevoked !== null && record?.revokedAt == null) {
        try {
          record =
            (await records.markRevoked(
              hostId,
              seenRevoked,
              this.now(),
              record?.deviceId ?? null
            )) ?? record;
        } catch (error) {
          return show(failure("records-unavailable", this.now(), formatErrorMessage(error, "")));
        }
        check();
      }

      let replace: string | undefined;
      if (identity.kind === "host" && mine) {
        const row = devices.find((d) => d.device_id === identity.deviceId);
        if (
          row &&
          row.revoked_at === null &&
          row.cert.role === "desktop-host" &&
          row.cert.signing_pub === identity.signingPub &&
          row.cert.exchange_pub === identity.exchangePub
        ) {
          if (record?.deviceId !== identity.deviceId || record.revokedAt !== null) {
            try {
              await records.markEnrolled(hostId, identity.deviceId, this.now());
            } catch {
              // Enrolled all the same; the record catches up on the next look.
            }
          }
          return show({ state: "enrolled", deviceId: identity.deviceId });
        }
        if (mode === "auto") return show({ state: row ? "revoked" : "stale" });
        replace = identity.deviceId;
      } else if (identity.kind === "host") {
        // Another relay's or owner's: never replaced from here, by Enroll either.
        return show({ state: "other-setup" });
      } else if (mode === "auto") {
        if (record?.revokedAt != null) return show({ state: "revoked" });
        if (!this.options.autoEnroll()) {
          // Not an attempt: turning automatic enrollment on offers this link one.
          if (this.attempted.get(link) === owner.key) this.attempted.delete(link);
          return show({ state: "not-enrolled" });
        }
      }

      const stillWanted = (): void => {
        check();
        if (mode === "auto" && !this.options.autoEnroll()) {
          throw new Superseded();
        }
      };
      stillWanted();
      show({ state: "enrolling" });
      const attempt = this.newAttemptId();
      const requested = await link.request({
        attempt,
        label: this.labelFor(hostId),
        ...(replace !== undefined ? { replace } : {}),
      });
      check();
      if (!requested.ok) return show(this.callFailure(requested));
      if (requested.value.step === "refused") return show(this.refusal(requested.value));
      stillWanted();
      if (mode === "auto") {
        // Revoked from Devices while the Host made its keys: not now, not automatically.
        let latest: HostRecord | null;
        try {
          latest = await records.get(hostId);
        } catch (error) {
          return show(failure("records-unavailable", this.now(), formatErrorMessage(error, "")));
        }
        stillWanted();
        if (latest?.revokedAt != null) return show({ state: "revoked" });
      }
      let enrolled: { response: string } | DecisionsRelayRequestFailure;
      try {
        enrolled = await owner.enroll(requested.value.request);
      } catch (error) {
        check();
        return show(this.enrollThrew(error));
      }
      check();
      if (isRelayFailure(enrolled)) return show(this.relayFailure(enrolled));
      // Registered: from here the Host's answer is all that's left, so a
      // setting turned off meanwhile doesn't strand what the relay holds.
      const accepted = await link.accept({ attempt, response: enrolled.response });
      if (generation !== this.generation) throw new Superseded();
      if (!accepted.ok) return show(this.callFailure(accepted));
      if (accepted.value.step === "refused") return show(this.refusal(accepted.value));
      try {
        await records.markEnrolled(hostId, accepted.value.deviceId, this.now());
      } catch (error) {
        console.warn("[Decisions] An enrolled Host couldn't be recorded:", error);
      }
      show({ state: "enrolled", deviceId: accepted.value.deviceId });
    } catch (error) {
      // A run that stopped short shows what was there before it, not "checking".
      const shown = this.views.get(hostId)?.enrollment.state;
      if (generation === this.generation && (shown === "checking" || shown === "enrolling")) {
        if (before) this.views.set(hostId, before);
        else this.views.delete(hostId);
      }
      throw error;
    } finally {
      release();
    }
  }

  private labelFor(hostId: string): string {
    const name =
      this.port
        ?.hosts()
        .find((host) => host.hostId === hostId)
        ?.name.trim() || hostId;
    return name.length > MAX_LABEL_LENGTH ? name.slice(0, MAX_LABEL_LENGTH) : name;
  }

  private rowOf(
    owner: HostEnrollerOwner,
    hostId: string,
    name: string,
    record: HostRecord | null,
    always = false
  ): DecisionsHost | null {
    const connected = this.port?.linkFor(hostId) != null;
    const view = this.views.get(hostId);
    let enrollment: DecisionsHostEnrollment | null =
      view?.key === owner.key ? view.enrollment : null;
    if (enrollment === null) {
      if (record?.revokedAt != null) enrollment = { state: "revoked" };
      else if (record?.deviceId) enrollment = { state: "enrolled", deviceId: record.deviceId };
      else if (connected || always) enrollment = { state: "unchecked" };
    }
    if (enrollment === null) return null;
    const busy =
      this.runs.has(hostId) || enrollment.state === "checking" || enrollment.state === "enrolling";
    // What the Host itself last said of its Decisions (#16022), as it said it.
    const runtime = this.port?.runtimeOf(hostId) ?? null;
    return {
      hostId,
      name: name || hostId,
      connected,
      enrollment,
      canEnroll: connected && !busy && ENROLLABLE.has(enrollment.state),
      ...(runtime ? { runtime } : {}),
    };
  }

  private callFailure(
    outcome: Extract<HostCallOutcome<unknown>, { ok: false }>
  ): DecisionsHostEnrollment {
    switch (outcome.failure) {
      case "needs-update":
        return { state: "needs-update" };
      case "disconnected":
        return failure("disconnected", this.now());
      case "outcome-unknown":
        return failure("outcome-unknown", this.now());
      case "unexpected-answer":
        return failure("unexpected-answer", this.now());
      case "failed":
        return failure("host-refused", this.now(), outcome.detail);
    }
  }

  private refusal(refused: HostEnrollRefusal): DecisionsHostEnrollment {
    switch (refused.reason) {
      case "own-setup":
        return { state: "own-setup" };
      case "no-keychain":
        return failure("no-keychain", this.now(), refused.detail);
      case "unreadable":
        return failure("host-keys-unreadable", this.now(), refused.detail);
      case "enrolled":
        return failure("host-refused", this.now(), "It holds another Decisions identity now");
      case "stale-attempt":
        return failure("host-refused", this.now(), "It no longer held the keys it made for this");
      case "rejected":
      case "unsaved":
        return failure("host-refused", this.now(), refused.detail);
    }
  }

  private relayFailure(failed: DecisionsRelayRequestFailure): DecisionsHostEnrollment {
    switch (failed.result) {
      case "not-set-up":
        return failure("owner-keys", this.now());
      case "unreachable":
        return failure("relay-unreachable", this.now(), failed.reason);
      case "refused":
        return failure("relay-refused", this.now(), failed.reason);
      case "key-storage":
        return failure("owner-keys", this.now(), failed.reason);
    }
  }

  private enrollThrew(error: unknown): DecisionsHostEnrollment {
    if (error instanceof RelayError && error.code === "forbidden") {
      return failure("relay-full", this.now());
    }
    return failure(
      "relay-rejected",
      this.now(),
      formatErrorMessage(error, "The relay didn't take the enrollment")
    );
  }
}
