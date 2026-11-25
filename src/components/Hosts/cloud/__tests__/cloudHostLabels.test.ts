import { describe, expect, it } from "vitest";
import type { CloudHostStatus } from "@shared/types/cloudHosts";
import {
  canCheckMachine,
  canDeleteMachines,
  canStartMachine,
  canStopMachine,
  cloudChipStatus,
  cloudCostFacts,
  cloudStatusLabel,
  clockTime,
  DELETE_ONLY_LOSS,
  DELETE_ONLY_RUNS,
  dayTime,
  idleClockSentence,
  idleEndSentence,
  IDLE_STOP_UNKNOWN,
  IDLE_TIME_COUNTED,
  isDeleteOnly,
  isObservationStale,
  keepMachineDescription,
  formatHourly,
  lifetimeSentence,
  providerStopSentence,
  startBillingSentence,
  stopKeepsSentence,
  stoppedBillingSentence,
  machineSpecLabel,
  idleSleepTimerSentence,
  offerPriceLabel,
} from "../cloudHostLabels";
import { BOAT_PROVIDER, DELETE_ONLY_PROVIDER, provider } from "./cloudProviderFixtures";

function status(overrides: Partial<CloudHostStatus> = {}): CloudHostStatus {
  return {
    hostId: "build",
    providerId: "boat",
    providerUnavailable: null,
    accountId: "ca_0123456789",
    accountName: "Personal",
    resourceId: "bx_23456789",
    machineName: "build",
    ownership: "created-by-daintree",
    createdFor: null,
    worktreeCleanup: null,
    provisioning: null,
    machine: "running",
    rawState: "ready",
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    hourlyDollars: 0.036,
    lifetime: { kind: "renewable" },
    autoStopAt: null,
    lifetimeSeconds: 7200,
    stoppedAt: null,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    operation: null,
    lastError: null,
    observedAt: 0,
    lastEndpoint: null,
    hostKeyFingerprint: null,
    hostKeyReview: null,
    keptRunningAt: null,
    asleep: false,
    ...overrides,
  };
}

describe("cloud host labels", () => {
  it("says what Daintree is doing before what the provider reports", () => {
    expect(
      cloudStatusLabel(
        status({
          machine: "stopped",
          operation: { id: "o", kind: "starting", startedAt: 0, stage: "" },
        })
      )
    ).toBe("Machine starting");
    expect(
      cloudStatusLabel(
        status({
          operation: { id: "o", kind: "stopping", startedAt: 0, stage: "" },
          stop: { status: "failing", error: "disk" },
        })
      )
    ).toBe("Machine stopping, retrying the save");
    expect(cloudStatusLabel(status({ machine: "stopped" }))).toBe("Machine stopped");
  });

  it("names an order waiting on the person's choice wherever the machine's state shows", () => {
    const offer = (choosable: boolean) =>
      choosable
        ? {
            id: "a",
            hourlyDollars: 0.03,
            bidder: { id: "p", name: "P", region: null },
            choosable: true as const,
            reason: null,
          }
        : {
            id: "b",
            hourlyDollars: 0.02,
            bidder: { id: "q", name: "Q", region: null },
            choosable: false as const,
            reason: "not on your trusted list",
          };
    const choosing = (
      offers: ReturnType<typeof offer>[],
      overrides: Partial<CloudHostStatus> = {}
    ) =>
      status({
        resourceId: null,
        machine: "not-created",
        operation: null,
        // Whatever went wrong before, the choice is what's wanted now.
        lastError: { code: "refused", message: "closed", at: 0 },
        pendingCreate: {
          kind: "awaiting-offer",
          order: { id: "dseq-1" },
          waitingSince: 0,
          offers,
          offersReadAt: null,
        },
        ...overrides,
      });
    expect(cloudStatusLabel(choosing([]))).toBe("Waiting for offers");
    // Offers nobody can choose are no offer to act on yet.
    expect(cloudStatusLabel(choosing([offer(false)]))).toBe("Waiting for offers");
    expect(cloudStatusLabel(choosing([offer(false), offer(true)]))).toBe("Offers ready");
    expect(cloudChipStatus(choosing([offer(true)]), BOAT_PROVIDER)).toBe("offers ready");
    expect(cloudChipStatus(choosing([]), BOAT_PROVIDER)).toBe("waiting for offers");
    // Ahead of an operation, a stale reading, or whatever the provider last said.
    expect(
      cloudStatusLabel(
        choosing([], { operation: { id: "o", kind: "creating", startedAt: 0, stage: "" } })
      )
    ).toBe("Waiting for offers");
    expect(cloudStatusLabel(choosing([], { machine: "running", resourceId: "x" }), true)).toBe(
      "Waiting for offers"
    );
    expect(cloudStatusLabel(choosing([], { machine: "unknown" }))).toBe("Waiting for offers");
    // Once chosen, the machine's own state is back.
    expect(cloudStatusLabel(choosing([], { pendingCreate: null }))).toBe("Setup incomplete");
  });

  it("prices an offer by the hour and by a month of running, from the quote itself", () => {
    expect(offerPriceLabel(0.036)).toBe("$0.036 an hour · about $26.28 a month");
    // The month is the quote times 730, not the rounded hourly figure times 730.
    expect(offerPriceLabel(0.03649)).toBe("$0.036 an hour · about $26.64 a month");
    expect(offerPriceLabel(1.5)).toBe("$1.500 an hour · about $1,095.00 a month");
  });

  it("tells an unfinished create from a host never created", () => {
    expect(cloudStatusLabel(status({ resourceId: null, machine: "not-created" }))).toBe(
      "Not created"
    );
    expect(
      cloudStatusLabel(
        status({
          resourceId: null,
          machine: "not-created",
          lastError: { code: "outcome-unknown", message: "lost", at: 0 },
        })
      )
    ).toBe("Setup incomplete");
  });

  it("offers Start only for a stopped machine with data, and Stop only for a running one", () => {
    expect(canStartMachine(status({ machine: "stopped" }))).toBe(true);
    expect(canStartMachine(status({ machine: "stopped", dataExpired: true }))).toBe(false);
    expect(canStartMachine(status({ machine: "running" }))).toBe(false);
    expect(
      canStartMachine(
        status({
          machine: "stopped",
          operation: { id: "o", kind: "deleting", startedAt: 0, stage: "" },
        })
      )
    ).toBe(false);
    expect(canStopMachine(status({ machine: "running" }))).toBe(true);
    expect(
      canStopMachine(
        status({
          machine: "starting",
          operation: { id: "o", kind: "starting", startedAt: 0, stage: "" },
        })
      )
    ).toBe(true);
    expect(canStopMachine(status({ machine: "stopped" }))).toBe(false);
    expect(canStopMachine(status({ resourceId: null, machine: "not-created" }))).toBe(false);
  });

  it("puts a finite retention into the stop promise, and none when the disk is kept", () => {
    const persistence = {
      kept: "Files",
      lost: "caches",
      saveRetryBilled: false,
      stoppedComputeBilled: false,
      stoppedStorageBilled: false,
    };
    expect(stopKeepsSentence({ ...persistence, retentionDays: 14 })).toBe(
      "Files are kept for at least 14 days while it's stopped, and may be deleted after that; caches aren't."
    );
    expect(stopKeepsSentence({ ...persistence, retentionDays: null })).toBe(
      "Files are kept for when you start it again; caches aren't."
    );
  });

  it("says an imported lifetime exactly, never rounded to the hour", () => {
    const renewable = { kind: "renewable" } as const;
    expect(lifetimeSentence(renewable, 1800)).toContain("30 minutes after starting");
    expect(lifetimeSentence(renewable, 5400)).toContain("90 minutes after starting");
    expect(lifetimeSentence(renewable, 7200)).toContain("2 hours after starting");
    expect(lifetimeSentence(renewable, null)).toBe("It runs until you stop it.");
  });

  it("words when a machine stops by itself in its provider's terms", () => {
    // Only a renewable lifetime is pushed back; a fixed one holds even while it's in use.
    expect(lifetimeSentence({ kind: "renewable" }, 7200)).toContain("pushed back");
    const fixed = lifetimeSentence({ kind: "fixed-at-create", canChangeWhileStopped: true }, 7200);
    expect(fixed).toContain("2 hours after starting");
    expect(fixed).toContain("can't be extended");
    expect(fixed).not.toContain("pushed back");
    // No limit on the provider's side is not a promise it runs until stopped: its host may stop it (#17362).
    const unlimited = lifetimeSentence(
      { kind: "fixed-at-create", canChangeWhileStopped: true },
      null
    );
    expect(unlimited).not.toContain("until you stop it");
    expect(unlimited).not.toContain("can't be extended");
    // A stored lifetime means nothing to a provider that doesn't take one.
    expect(lifetimeSentence({ kind: "none" }, 7200)).toBe("It runs until you stop it.");
    expect(lifetimeSentence({ kind: "idle-sleep", idleSeconds: 1800 }, 7200)).toBe(
      "It sleeps by itself after 30 minutes without activity."
    );
    expect(lifetimeSentence({ kind: "idle-sleep", idleSeconds: 45 }, null)).toContain("45 seconds");
    // Never rounded: 90 seconds isn't "2 minutes".
    expect(lifetimeSentence({ kind: "idle-sleep", idleSeconds: 90 }, null)).toContain(
      "after 90 seconds without"
    );
    expect(lifetimeSentence({ kind: "idle-sleep", idleSeconds: null }, null)).toContain(
      "once it's been idle"
    );
    // An unregistered provider's model isn't known, so nothing is promised.
    expect(lifetimeSentence(null, 7200)).toBe("");
  });

  it("names the provider that stops a machine when a create doesn't choose when", () => {
    expect(providerStopSentence({ kind: "none" }, "Acme")).toContain("Acme has no lifetime");
    expect(providerStopSentence({ kind: "idle-sleep", idleSeconds: 600 }, "Acme")).toContain(
      "Acme puts it to sleep by itself after 10 minutes"
    );
    expect(providerStopSentence({ kind: "renewable" }, "Acme")).toBeNull();
    expect(
      providerStopSentence({ kind: "fixed-at-create", canChangeWhileStopped: false }, "Acme")
    ).toBeNull();
  });

  it("says no auto-stop only where the provider's model has none", () => {
    expect(cloudCostFacts(status({ lifetime: { kind: "none" } }), BOAT_PROVIDER)).toContain(
      "no auto-stop"
    );
    const idle = cloudCostFacts(
      status({ lifetime: { kind: "idle-sleep", idleSeconds: 1800 } }),
      BOAT_PROVIDER
    );
    expect(idle).toContain("sleeps when idle");
    expect(idle).not.toContain("no auto-stop");
    expect(cloudCostFacts(status({ lifetime: null }), BOAT_PROVIDER)).toEqual(["$0.036/h"]);
    // A fixed limit whose deadline wasn't reported is unknown, not none.
    const fixed = { kind: "fixed-at-create", canChangeWhileStopped: false } as const;
    expect(
      cloudCostFacts(status({ lifetime: fixed, lifetimeSeconds: 7200 }), BOAT_PROVIDER)
    ).toEqual(["$0.036/h"]);
    expect(
      cloudCostFacts(status({ lifetime: fixed, lifetimeSeconds: null }), BOAT_PROVIDER)
    ).toContain("no auto-stop");
    // Boat's renewable lifetime says what it always said with no deadline reported.
    expect(cloudCostFacts(status({ lifetimeSeconds: 7200 }), BOAT_PROVIDER)).toContain(
      "no auto-stop"
    );
    const deadline = new Date(Date.UTC(2026, 10, 14, 12)).toISOString();
    expect(
      cloudCostFacts(
        status({ lifetime: { kind: "idle-sleep", idleSeconds: 60 }, autoStopAt: deadline }),
        BOAT_PROVIDER
      ).some((fact) => fact.startsWith("stops by itself"))
    ).toBe(true);
  });

  it("never reads an unknown state as stopped", () => {
    const unknown = status({ machine: "unknown" });
    expect(cloudStatusLabel(unknown)).toBe("Couldn't check the machine");
    expect(canStartMachine(unknown)).toBe(false);
    expect(canStopMachine(unknown)).toBe(false);
    expect(canCheckMachine(unknown, 0)).toBe(true);
    // The chip never truncates its status, so the long ones have short forms.
    expect(cloudChipStatus(unknown, BOAT_PROVIDER)).toBe("state unknown");
    expect(
      cloudChipStatus(
        status({
          operation: { id: "o", kind: "stopping", startedAt: 0, stage: "" },
          stop: { status: "failing", error: "disk" },
        }),
        BOAT_PROVIDER
      )
    ).toBe("machine stopping");
  });

  it("marks a reading past its freshness as the last one", () => {
    const minute = 60_000;
    const stopped = status({ machine: "stopped", observedAt: 0 });
    expect(isObservationStale(stopped, 10 * minute)).toBe(false);
    expect(isObservationStale(stopped, 13 * minute)).toBe(true);
    expect(cloudStatusLabel(stopped, true)).toBe("Last reported stopped");
    expect(canCheckMachine(stopped, 13 * minute)).toBe(true);

    const running = status({ machine: "running", observedAt: 0 });
    expect(isObservationStale(running, 2 * minute)).toBe(false);
    expect(isObservationStale(running, 4 * minute)).toBe(true);
    // Under way, Daintree is polling every few seconds: never stale, never "last reported".
    const starting = status({
      machine: "stopped",
      observedAt: 0,
      operation: { id: "o", kind: "starting", startedAt: 0, stage: "" },
    });
    expect(isObservationStale(starting, 60 * minute)).toBe(false);
    expect(cloudStatusLabel(starting, true)).toBe("Machine starting");
    expect(isObservationStale(status({ observedAt: null }), 0)).toBe(true);
    expect(isObservationStale(status({ resourceId: null, observedAt: null }), 0)).toBe(false);
  });

  it("formats what is known of a size and its price", () => {
    expect(machineSpecLabel(4, 8)).toBe("4 vCPU · 8 GB");
    expect(machineSpecLabel(null, null)).toBe("Size unknown");
    expect(formatHourly(0.0361)).toBe("$0.036 an hour while running");
    expect(formatHourly(null)).toBe("Price not reported");
  });
});

describe("idleClockSentence (#17357)", () => {
  const at = (ms: number) => clockTime(new Date(ms).toISOString());
  const base = Date.UTC(2026, 10, 17, 14, 2);

  it("says what the idle time counts from when the host reports no clock", () => {
    expect(idleClockSentence(undefined, null)).toBe(IDLE_TIME_COUNTED);
  });

  it("says the host is in use while its clock is held", () => {
    const sentence = idleClockSentence(
      { idleAfterMinutes: 30, lastWorkAt: base, busy: true, idleEndsAt: null },
      base
    );
    expect(sentence.startsWith("In use now.")).toBe(true);
    expect(sentence).not.toContain(at(base)!);
  });

  it("says since when it has been idle and when its idle time ends, by the host's own clock", () => {
    const idle = {
      idleAfterMinutes: 30,
      lastWorkAt: base,
      busy: false,
      idleEndsAt: base + 30 * 60_000,
    };
    expect(idleClockSentence(idle, base + 60_000)).toBe(
      `Idle since ${at(base)}. Its idle time ends ${at(base + 30 * 60_000)}.`
    );
    // Passed by the host's clock when it last looked, whatever this machine's says.
    expect(idleClockSentence(idle, base + 30 * 60_000)).toBe(
      `Idle since ${at(base)}. Its idle time ended ${at(base + 30 * 60_000)}.`
    );
  });

  it("says the machine stops by itself only when its host says it holds a key to (#17361)", () => {
    const idle = {
      idleAfterMinutes: 30,
      lastWorkAt: base,
      busy: false,
      idleEndsAt: base + 30 * 60_000,
    };
    const armed = { ...idle, stopsWhenIdle: true };
    expect(idleClockSentence(armed, base + 60_000)).toBe(
      `Idle since ${at(base)}. It stops by itself ${at(base + 30 * 60_000)} if it stays idle.`
    );
    expect(idleClockSentence(armed, base + 30 * 60_000)).toBe(
      `Idle since ${at(base)}. Its idle time ended ${at(base + 30 * 60_000)}, so it stops by itself.`
    );
    expect(idleClockSentence({ ...armed, busy: true, idleEndsAt: null }, base)).toMatch(
      /^In use now\. .*stops by itself once idle that long\.$/
    );
    // A host that doesn't say so keeps the clock's own words.
    expect(idleClockSentence({ ...idle, stopsWhenIdle: false }, base + 60_000)).toBe(
      idleClockSentence(idle, base + 60_000)
    );
  });
});

describe("idleEndSentence (#17921)", () => {
  const idle = { idleAfterMinutes: 30, lastWorkAt: 0, busy: false, idleEndsAt: 30 * 60_000 };
  const armed = { ...idle, stopsWhenIdle: true };
  const refused = "This machine can't stop itself when idle: the key isn't allowed.";
  const digitalOcean = provider({
    name: "DigitalOcean",
    stoppedBilling: "DigitalOcean bills a stopped Droplet in full until it's deleted.",
  });

  it("adds nothing once the host says it stops the machine itself, whose clock says so", () => {
    expect(idleEndSentence(armed, BOAT_PROVIDER, null)).toBeNull();
    // Its word settles a reason found before it, and outranks what the provider declares.
    expect(idleEndSentence(armed, BOAT_PROVIDER, refused)).toBeNull();
    expect(idleEndSentence(armed, digitalOcean, null)).toBeNull();
  });

  it("keeps a refused self-stop's reason, word for word", () => {
    expect(idleEndSentence(idle, BOAT_PROVIDER, refused)).toBe(refused);
    expect(idleEndSentence(undefined, BOAT_PROVIDER, refused)).toBe(refused);
    expect(idleEndSentence(idle, digitalOcean, refused)).toBe(refused);
  });

  it("says a DigitalOcean Droplet doesn't stop, and bills stopped anyway, in DigitalOcean's words", () => {
    const said = idleEndSentence(idle, digitalOcean, null)!;
    expect(said.startsWith("On DigitalOcean, the machine doesn't stop")).toBe(true);
    expect(said.endsWith(` ${digitalOcean.capabilities.persistence.stoppedBilling}`)).toBe(true);
    // Known from the provider alone: the same with no link or no summary.
    expect(idleEndSentence(undefined, digitalOcean, null)).toBe(said);
  });

  it("names a plugin's provider, with what a stopped machine costs only where it bills one", () => {
    const quiet = provider({ name: "Acme", stoppedComputeBilled: false });
    expect(idleEndSentence(idle, quiet, null)).toBe(
      "On Acme, the machine doesn't stop when the host's idle time ends."
    );
    const billed = idleEndSentence(idle, provider({ name: "Acme" }), null)!;
    expect(billed).toContain("doesn't stop when the host's idle time ends.");
    expect(billed).toContain("Acme keeps billing a stopped machine for compute");
  });

  it("says a plugin's machine is stopped by this device while it's linked, and keeps running with every device away (#17923)", () => {
    const acme = provider({ name: "Acme", stoppedComputeBilled: false });
    const said = idleEndSentence(idle, acme, null, { kind: "stops" })!;
    expect(said).toContain("While this device is linked to the host, it stops the machine");
    expect(said).toContain("With every device away, the machine keeps running.");
    // Known from this device's own findings: the same before any summary, or with no link.
    expect(idleEndSentence(undefined, acme, null, { kind: "stops" })).toBe(said);
    // The host's word that it stops the machine itself still settles it.
    expect(idleEndSentence(armed, acme, null, { kind: "stops" })).toBeNull();
  });

  it("says why this device doesn't stop a plugin's machine, or that it can't tell yet", () => {
    const acme = provider({ name: "Acme", stoppedComputeBilled: false });
    const problem =
      "This device doesn't stop the machine when the host's idle time ends: snapshots are off on it.";
    expect(idleEndSentence(idle, acme, null, { kind: "blocked", problem })).toBe(problem);
    expect(idleEndSentence(idle, acme, null, { kind: "unknown" })).toBe(IDLE_STOP_UNKNOWN);
    // An unregistered provider promises nothing, whatever was found before it left.
    expect(idleEndSentence(idle, null, null, { kind: "stops" })).toBe(IDLE_STOP_UNKNOWN);
  });

  it("says why a machine can't stop itself, then that this device stops it instead while linked (#17924)", () => {
    const said = idleEndSentence(idle, BOAT_PROVIDER, refused, { kind: "stops" })!;
    expect(said.startsWith(refused)).toBe(true);
    expect(said).toContain("While this device is linked to the host, it stops the machine");
    // A machine with a runtime limit still stops once it runs out, so nothing is said of every device away.
    expect(said).not.toContain("keeps running");
    // Known from this device's own findings: the same before any summary.
    expect(idleEndSentence(undefined, BOAT_PROVIDER, refused, { kind: "stops" })).toBe(said);
    // The host's word that it stops the machine itself settles it.
    expect(idleEndSentence(armed, BOAT_PROVIDER, refused, { kind: "stops" })).toBeNull();
    // A reason with no closing stop still reads as two sentences.
    expect(idleEndSentence(idle, BOAT_PROVIDER, "It can't stop itself", { kind: "stops" })).toMatch(
      /^It can't stop itself\. While this device/
    );
  });

  it("says why a machine can't stop itself, then why this device doesn't either, or the reason alone (#17924)", () => {
    const problem =
      "This device doesn't stop the machine when the host's idle time ends: snapshots are off on it.";
    expect(idleEndSentence(idle, BOAT_PROVIDER, refused, { kind: "blocked", problem })).toBe(
      `${refused} ${problem}`
    );
    // Not yet known whether a stop from here keeps the disk, or no stop from here at all: the reason alone.
    expect(idleEndSentence(idle, BOAT_PROVIDER, refused, { kind: "unknown" })).toBe(refused);
    expect(idleEndSentence(idle, BOAT_PROVIDER, refused, null)).toBe(refused);
    // An unregistered provider promises nothing beyond the reason.
    expect(idleEndSentence(idle, null, refused, { kind: "stops" })).toBe(refused);
    expect(idleEndSentence(idle, null, refused, { kind: "blocked", problem })).toBe(refused);
  });

  it("doesn't imply a stop where it can't be known", () => {
    // A provider whose hosts can stop it, before or without the host's word: an older host, no summary, no link.
    expect(idleEndSentence(idle, BOAT_PROVIDER, null)).toBe(IDLE_STOP_UNKNOWN);
    expect(idleEndSentence(undefined, BOAT_PROVIDER, null)).toBe(IDLE_STOP_UNKNOWN);
    expect(idleEndSentence({ ...idle, stopsWhenIdle: false }, BOAT_PROVIDER, null)).toBe(
      IDLE_STOP_UNKNOWN
    );
    // A provider that isn't registered, or a declaration that doesn't say.
    expect(idleEndSentence(idle, null, null)).toBe(IDLE_STOP_UNKNOWN);
    const { hostIdleStop: _said, ...undeclared } = BOAT_PROVIDER;
    expect(idleEndSentence(idle, undeclared, null)).toBe(IDLE_STOP_UNKNOWN);
  });
});

describe("what holds an Agent 37 instance awake with no device connected (#17918)", () => {
  const agent37 = provider({ name: "Agent 37" });
  const lifetime = { kind: "idle-sleep" as const, idleSeconds: 1800 };
  const expiresAt = Date.UTC(2026, 10, 26, 15, 0);
  const confirmedAt = Date.UTC(2026, 10, 19, 15, 0);
  const sentence = (
    keepAwake: Parameters<typeof idleSleepTimerSentence>[2]["keepAwake"],
    connected = false
  ) =>
    idleSleepTimerSentence(agent37, undefined, {
      connected,
      lifetime,
      followsHost: true,
      keepAwake,
    });

  it("says the host keeps it awake while it sees work through a link it holds until its expiry, and the timer after", () => {
    const held = { kind: "held" as const, expiresAt, confirmedAt, reached: true };
    const offline = sentence(held);
    // Two different moments, each in its own place.
    expect(dayTime(expiresAt)).not.toBe(dayTime(confirmedAt));
    expect(offline).toContain(
      `the host sends requests through a link from Daintree to keep the machine awake while it sees work, and holds that link until ${dayTime(expiresAt)} (as the host said ${dayTime(confirmedAt)}).`
    );
    // Away, what this device knows is what the host said when it last asked.
    expect(offline).toContain(`(as the host said ${dayTime(confirmedAt)})`);
    expect(offline).toContain(
      "Once the host is idle, Agent 37's own idle timer (30 minutes) puts it to sleep after 30 minutes without activity."
    );
    expect(offline).not.toContain("is in charge while no device is connected");

    const linked = sentence(held, true);
    expect(linked).toContain("The host's idle time is in charge while this device is connected");
    expect(linked).toContain(`holds that link until ${dayTime(expiresAt)}.`);
    expect(linked).not.toContain("as the host said");
    expect(linked).not.toContain("no request through it");

    expect(sentence({ ...held, reached: false }, true)).toContain(
      "though no request through it has reached the host yet."
    );
    // Taken while the host was idle, it hasn't been tried: said so, not taken for protection.
    expect(sentence({ ...held, reached: false })).toContain(
      `holds that link until ${dayTime(expiresAt)}, though no request through it has reached the host yet (as the host said ${dayTime(confirmedAt)}).`
    );
  });

  it("says Agent 37's own timer is in charge once the link expired, was refused, or was never given", () => {
    const expired = sentence({ kind: "expired", expiredAt: expiresAt });
    expect(expired).toContain(
      "Agent 37's own idle timer (30 minutes) is in charge while no device is connected, even while the host sees work"
    );
    expect(expired).toContain(`expired ${dayTime(expiresAt)}. Connecting renews it.`);

    const refused = sentence({
      kind: "none",
      problem: "The host refused the link Daintree gave it",
    });
    expect(refused).toContain(
      "is in charge while no device is connected, even while the host sees work: The host refused the link Daintree gave it."
    );
    const refusedLinked = sentence({ kind: "none", problem: "Refused." }, true);
    expect(refusedLinked).toContain(
      "The host's idle time is in charge while this device is connected"
    );
    expect(refusedLinked).toContain("even while the host sees work: Refused.");
    expect(refusedLinked).not.toContain("Refused..");
    expect(sentence({ kind: "none", problem: "Refused!" })).toContain("work: Refused! ");

    // Nothing handed over yet, or a status from before it: the timer, as before.
    for (const nothing of [{ kind: "none" as const, problem: null }, null, undefined]) {
      expect(sentence(nothing)).toBe(
        "Agent 37's own idle timer (30 minutes) is in charge while no device is connected: it puts the machine to sleep after 30 minutes without activity. The host's idle time takes over while this device is connected."
      );
    }
    // Linked, a host that said it holds none still leaves the machine to Agent 37's timer once
    // this device goes; a status from before keep-awake adds nothing.
    expect(sentence({ kind: "none", problem: null }, true)).toContain(
      "Agent 37's own idle timer (30 minutes) is in charge while no device is connected: it puts the machine to sleep after 30 minutes without activity."
    );
    expect(sentence(null, true)).not.toContain("no device is connected");
  });
});

describe("what stopping and deleting mean for each provider (#17346)", () => {
  const stopped = status({ machine: "stopped" });

  it("leaves Boat's stop copy, facts and chip exactly as they were", () => {
    expect(stoppedBillingSentence(BOAT_PROVIDER)).toBeNull();
    expect(stopKeepsSentence(BOAT_PROVIDER.capabilities.persistence)).toBe(
      "Files in its home folder are kept for at least 14 days while it's stopped, and may be deleted after that; /tmp, caches and memory aren't."
    );
    expect(cloudCostFacts(stopped, BOAT_PROVIDER)).toEqual(["$0.036/h when started"]);
    expect(cloudChipStatus(stopped, BOAT_PROVIDER)).toBe("machine stopped");
    expect(canDeleteMachines(BOAT_PROVIDER)).toBe(true);
  });

  it("words a stopped machine's bill as its provider does, still saying how to stop paying", () => {
    const worded = (stoppedComputeBilled: boolean, deletion: boolean) => {
      const declared = provider({ stoppedComputeBilled, deletion });
      declared.capabilities = {
        ...declared.capabilities,
        persistence: {
          ...declared.capabilities.persistence,
          stoppedBilling: "Acme bills a stopped box in full until it's deleted.",
        },
      };
      return stoppedBillingSentence(declared);
    };
    expect(worded(true, true)).toBe(
      "Acme bills a stopped box in full until it's deleted. To stop paying for it, remove the host and delete its machine."
    );
    expect(worded(true, false)).toBe(
      "Acme bills a stopped box in full until it's deleted. To stop paying for it, delete the machine in Acme's console."
    );
    // The wording only says how a billed stop bills: a stop that ends the bill needs no warning.
    expect(worded(false, true)).toBeNull();
  });

  it("says a stopped machine still bills, and that deleting it is how to stop paying", () => {
    const billed = provider({ stoppedComputeBilled: true, deletion: true });
    expect(stoppedBillingSentence(billed)).toBe(
      "Acme keeps billing a stopped machine for compute until it's deleted. To stop paying for it, remove the host and delete its machine."
    );
    // The running rate is no longer what a start costs: the stop never ended the bill.
    expect(cloudCostFacts(stopped, billed)).toEqual(["still billing"]);
    expect(cloudChipStatus(stopped, billed)).toBe("stopped, still billing");
    // A running machine's facts are the same either way.
    expect(cloudCostFacts(status(), billed)).toEqual(["$0.036/h", "no auto-stop"]);
    expect(cloudCostFacts(status(), BOAT_PROVIDER)).toEqual(["$0.036/h", "no auto-stop"]);
    // An expired disk is why it can't start: the chip keeps saying that.
    expect(cloudChipStatus(status({ machine: "stopped", dataExpired: true }), billed)).toBe(
      "machine saved disk expired"
    );
  });

  it("points to the provider's console when Daintree can't delete there", () => {
    const consoleOnly = provider({ stoppedComputeBilled: true, deletion: false });
    expect(stoppedBillingSentence(consoleOnly)).toBe(
      "Acme keeps billing a stopped machine for compute until it's deleted. To stop paying for it, delete the machine in Acme's console."
    );
    expect(canDeleteMachines(consoleOnly)).toBe(false);
  });

  it("reads the two declarations independently", () => {
    const noDelete = provider({ stoppedComputeBilled: false, deletion: false });
    expect(stoppedBillingSentence(noDelete)).toBeNull();
    expect(cloudCostFacts(stopped, noDelete)).toEqual(["$0.036/h when started"]);
    expect(canDeleteMachines(noDelete)).toBe(false);
  });

  it("claims nothing for a provider that isn't registered", () => {
    expect(stoppedBillingSentence(null)).toBeNull();
    expect(cloudCostFacts(stopped, null)).toEqual(["$0.036/h when started"]);
    // A delete through it is refused in main with the reason it's unavailable.
    expect(canDeleteMachines(null)).toBe(true);
  });
});

describe("a machine that sleeps when idle and bills its disk while parked (#17347)", () => {
  const sleeper = provider({
    name: "Agent 37",
    stoppedComputeBilled: false,
    stoppedStorageBilled: true,
    lifetime: { kind: "idle-sleep", idleSeconds: 900 },
  });

  it("says a stopped or asleep machine bills only for its disk", () => {
    expect(stoppedBillingSentence(sleeper)).toBe(
      "Agent 37 bills only for its disk while it's stopped or asleep."
    );
    const stopsOnly = provider({
      name: "Agent 37",
      stoppedComputeBilled: false,
      stoppedStorageBilled: true,
    });
    expect(stoppedBillingSentence(stopsOnly)).toBe(
      "Agent 37 bills only for its disk while it's stopped."
    );
    // Storage alone is no compute bill: a stopped machine's facts and chip stay a start's price.
    const stopped = status({ machine: "stopped", lifetime: sleeper.capabilities.lifetime });
    expect(cloudCostFacts(stopped, sleeper)).toEqual(["$0.036/h when started"]);
    expect(cloudChipStatus(stopped, sleeper)).toBe("machine stopped");
  });

  it("calls a machine the provider slept on idle asleep, and offers to start it", () => {
    // The normalized fact decides, whatever the provider's own word for it.
    const asleep = status({ machine: "stopped", asleep: true, rawState: "parked" });
    expect(cloudStatusLabel(asleep)).toBe("Machine asleep");
    expect(cloudStatusLabel(asleep, true)).toBe("Last reported asleep");
    expect(cloudChipStatus(asleep, sleeper)).toBe("machine asleep");
    expect(canStartMachine(asleep)).toBe(true);
    expect(canStopMachine(asleep)).toBe(false);
    // Running, it says it sleeps when idle rather than claiming no auto-stop.
    expect(cloudCostFacts(status({ lifetime: sleeper.capabilities.lifetime }), sleeper)).toEqual([
      "$0.036/h",
      "sleeps when idle",
    ]);
  });
});

describe("startBillingSentence", () => {
  const billed = provider({ stoppedComputeBilled: true, deletion: true });

  it("says what a start bills, and that a stopped machine already bills where it does", () => {
    expect(startBillingSentence(status({ machine: "stopped" }), billed)).toBe(
      "It bills Personal about $0.036 an hour while it runs. Acme keeps billing a stopped machine for compute until it's deleted. To stop paying for it, remove the host and delete its machine."
    );
  });

  it("claims no stopped billing for a machine that isn't stopped, or a provider that has none", () => {
    expect(startBillingSentence(status({ machine: "error" }), billed)).toBe(
      "Starting it bills Personal about $0.036 an hour while it runs."
    );
    expect(startBillingSentence(status({ machine: "running", accountName: "Team" }), billed)).toBe(
      "Starting it bills Team about $0.036 an hour while it runs."
    );
    expect(startBillingSentence(status({ machine: "stopped" }), BOAT_PROVIDER)).toBe(
      "Starting it bills Personal about $0.036 an hour while it runs."
    );
    expect(startBillingSentence(status({ machine: "stopped", hourlyDollars: null }), null)).toBe(
      "Starting it bills Personal for the time it runs while it runs."
    );
  });
});

describe("a provider that has no stop (#18229)", () => {
  const leasy = (overrides: Partial<CloudHostStatus> = {}) =>
    status({
      providerId: "leasy",
      lifetime: { kind: "none" },
      lifetimeSeconds: null,
      ...overrides,
    });

  it("offers neither Start nor Stop for its machine, whatever the machine reports", () => {
    for (const machine of ["running", "starting", "stopped", "error"] as const) {
      expect(canStartMachine(leasy({ machine }), DELETE_ONLY_PROVIDER)).toBe(false);
      expect(canStopMachine(leasy({ machine }), DELETE_ONLY_PROVIDER)).toBe(false);
    }
    expect(
      canStopMachine(
        leasy({
          machine: "starting",
          operation: { id: "o", kind: "starting", stage: "Starting", startedAt: 1 },
        }),
        DELETE_ONLY_PROVIDER
      )
    ).toBe(false);
    // The same readings on a provider that stops, and on one not registered, still offer both.
    expect(canStartMachine(leasy({ machine: "stopped" }), BOAT_PROVIDER)).toBe(true);
    expect(canStopMachine(leasy({ machine: "running" }), BOAT_PROVIDER)).toBe(true);
    expect(canStartMachine(leasy({ machine: "stopped" }), null)).toBe(true);
    expect(canStopMachine(leasy({ machine: "running" }), null)).toBe(true);
  });

  it("reads delete-only from the declaration alone", () => {
    expect(isDeleteOnly(DELETE_ONLY_PROVIDER)).toBe(true);
    expect(isDeleteOnly(BOAT_PROVIDER)).toBe(false);
    expect(isDeleteOnly(null)).toBe(false);
    expect(isDeleteOnly(undefined)).toBe(false);
  });

  it("says it runs until deleted, never a start price or a stopped bill", () => {
    expect(cloudCostFacts(leasy(), DELETE_ONLY_PROVIDER)).toEqual([
      "$0.036/h",
      "runs until deleted",
    ]);
    expect(cloudCostFacts(leasy({ machine: "stopped" }), DELETE_ONLY_PROVIDER)).toEqual([]);
    expect(stoppedBillingSentence(DELETE_ONLY_PROVIDER)).toBeNull();
  });

  it("says it runs, and bills, until it's deleted where a lifetime or a stop would be", () => {
    expect(lifetimeSentence({ kind: "none" }, null, DELETE_ONLY_PROVIDER)).toBe(DELETE_ONLY_RUNS);
    expect(lifetimeSentence(null, null, DELETE_ONLY_PROVIDER)).toBe(DELETE_ONLY_RUNS);
    expect(providerStopSentence({ kind: "none" }, "Leasy", "delete-only")).toBe(
      "Leasy has no stop: a machine runs, and bills, until it's deleted."
    );
    expect(DELETE_ONLY_RUNS).toBe("It runs, and bills, until it's deleted.");
    expect(DELETE_ONLY_LOSS).toBe("Deleting it loses everything on it, its disk included.");
    // Every other provider reads as it did.
    expect(lifetimeSentence({ kind: "none" }, null, BOAT_PROVIDER)).toBe(
      "It runs until you stop it."
    );
    expect(providerStopSentence({ kind: "none" }, "Acme")).toBe(
      "Acme has no lifetime for its machines: it runs until you stop it."
    );
  });

  it("says keeping it bills until it's deleted, never until it stops", () => {
    expect(keepMachineDescription(leasy(), "Leasy", false, false, 0, true, true)).toBe(
      "It keeps running, and billing Personal, until it's deleted. You can add it back from Add host."
    );
    expect(
      keepMachineDescription(leasy({ machine: "unknown" }), "Leasy", false, false, 0, false, true)
    ).toBe(
      "Daintree can't tell whether it's running; check on Leasy, where it keeps billing until it's deleted."
    );
    expect(keepMachineDescription(leasy(), "Leasy", false, false, 0, false)).toBe(
      "It's running and keeps billing Personal until it stops on Leasy."
    );
  });
});
