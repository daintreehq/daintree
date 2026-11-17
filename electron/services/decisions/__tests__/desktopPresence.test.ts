import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ powerMonitor: { on: vi.fn(), off: vi.fn() } }));

import { powerMonitor } from "electron";
import { PRESENCE_REPORT_MS } from "@daintreehq/decisions-client";
import type { UserPresence } from "../../userPresence.js";
import { DesktopPresence, PRESENCE_TICK_MS, type PresenceWatchers } from "../desktopPresence.js";
import {
  resetPowerPolicyForTesting,
  updatePowerObservations,
} from "../../../window/powerPolicy.js";

function harness(initial: UserPresence = "present") {
  let presence: UserPresence = initial;
  let allowed = true;
  const listeners = { suspend: new Set<() => void>(), resume: new Set<() => void>() };
  const change = new Set<() => void>();
  const watch: PresenceWatchers = {
    onSuspend: (l) => (listeners.suspend.add(l), () => listeners.suspend.delete(l)),
    onResume: (l) => (listeners.resume.add(l), () => listeners.resume.delete(l)),
    onChange: (l) => (change.add(l), () => change.delete(l)),
  };
  const reports: boolean[] = [];
  const presenceReporter = new DesktopPresence({
    read: () => presence,
    allowed: () => allowed,
    report: (present) => reports.push(present),
    watch,
  });
  return {
    presenceReporter,
    reports,
    set: (next: UserPresence) => (presence = next),
    allow: (next: boolean) => (allowed = next),
    suspend: () => listeners.suspend.forEach((l) => l()),
    resume: () => listeners.resume.forEach((l) => l()),
    change: () => change.forEach((l) => l()),
    watching: () => listeners.suspend.size + listeners.resume.size + change.size,
  };
}

describe("DesktopPresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports present at once and again on every tick while the person stays", () => {
    const h = harness("present");
    h.presenceReporter.update();
    expect(h.reports).toEqual([true]);
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    expect(h.reports).toEqual([true, true, true]);
    h.presenceReporter.stop();
  });

  it.each(["away", "unknown"] as const)("reports %s as away, once", (presence) => {
    const h = harness("present");
    h.presenceReporter.update();
    h.set(presence);
    vi.advanceTimersByTime(PRESENCE_TICK_MS * 3);
    expect(h.reports).toEqual([true, false]);
    h.presenceReporter.stop();
  });

  it.each(["away", "unknown"] as const)(
    "reports nothing while the person is %s from the start, until they're back",
    (presence) => {
      const h = harness(presence);
      h.presenceReporter.update();
      vi.advanceTimersByTime(PRESENCE_TICK_MS * 2);
      expect(h.reports).toEqual([]);
      h.set("present");
      vi.advanceTimersByTime(PRESENCE_TICK_MS);
      expect(h.reports).toEqual([true]);
      h.presenceReporter.stop();
    }
  );

  it("reports present as soon as a change says the person is back, without waiting for a tick", () => {
    const h = harness("present");
    h.presenceReporter.update();
    h.set("away");
    h.change();
    h.set("present");
    h.change();
    expect(h.reports).toEqual([true, false, true]);
    h.presenceReporter.stop();
  });

  it("runs nothing and reports nothing while it isn't allowed", () => {
    const h = harness("present");
    h.allow(false);
    h.presenceReporter.update();
    vi.advanceTimersByTime(PRESENCE_TICK_MS * 3);
    h.presenceReporter.refresh();
    expect(h.reports).toEqual([]);
    expect(h.watching()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the lease once when it stops being allowed, and reads afresh when it is again", () => {
    const h = harness("present");
    h.presenceReporter.update();
    h.allow(false);
    h.presenceReporter.update();
    vi.advanceTimersByTime(PRESENCE_TICK_MS * 2);
    expect(h.reports).toEqual([true, false]);
    expect(h.watching()).toBe(0);

    h.allow(true);
    h.presenceReporter.update();
    expect(h.reports).toEqual([true, false, true]);
    h.presenceReporter.stop();
  });

  it("notices on its next tick that it stopped being allowed", () => {
    const h = harness("present");
    h.presenceReporter.update();
    h.allow(false);
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    expect(h.reports).toEqual([true, false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is away from suspend until resume, whatever the idle state says", () => {
    const h = harness("present");
    h.presenceReporter.update();
    h.suspend();
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    expect(h.reports).toEqual([true, false]);
    h.resume();
    expect(h.reports).toEqual([true, false, true]);
    h.presenceReporter.stop();
  });

  it("ends the lease it started on stop, then reads and listens no more", () => {
    const h = harness("present");
    h.presenceReporter.update();
    expect(h.watching()).toBe(3);
    h.presenceReporter.stop();
    expect(h.reports).toEqual([true, false]);
    expect(h.watching()).toBe(0);
    vi.advanceTimersByTime(PRESENCE_TICK_MS * 3);
    h.presenceReporter.refresh();
    expect(h.reports).toEqual([true, false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing on stop when it last reported away", () => {
    const h = harness("present");
    h.presenceReporter.update();
    h.set("away");
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    h.presenceReporter.stop();
    expect(h.reports).toEqual([true, false]);
  });

  it("stays away through a change or a tick while asleep", () => {
    const h = harness("present");
    h.presenceReporter.update();
    h.suspend();
    h.change();
    h.presenceReporter.update();
    vi.advanceTimersByTime(PRESENCE_TICK_MS * 2);
    expect(h.reports).toEqual([true, false]);
    h.presenceReporter.stop();
  });

  it("carries on when a report throws, as a revoked bridge's does", () => {
    const report = vi.fn(() => {
      throw new Error("revoked");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const presence = new DesktopPresence({
      read: () => "present",
      allowed: () => true,
      report,
      watch: {
        onSuspend: () => () => {},
        onResume: () => () => {},
        onChange: () => () => {},
      },
    });
    presence.update();
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    expect(report).toHaveBeenCalledTimes(2);
    presence.stop();
    warn.mockRestore();
  });
});

describe("DesktopPresence on Electron's own signals", () => {
  afterEach(() => {
    resetPowerPolicyForTesting();
    vi.mocked(powerMonitor.on).mockClear();
    vi.mocked(powerMonitor.off).mockClear();
  });

  /** The listener the reporter gave `powerMonitor` for `event`. */
  function listener(event: string): () => void {
    const call = vi.mocked(powerMonitor.on).mock.calls.find(([name]) => name === event);
    if (!call) throw new Error(`No ${event} listener`);
    return call[1] as () => void;
  }

  it("reads again on suspend, resume, a lock or unlock and a focus change, and lets them all go on stop", () => {
    let presence: UserPresence = "present";
    const reports: boolean[] = [];
    const reporter = new DesktopPresence({
      read: () => presence,
      allowed: () => true,
      report: (present) => reports.push(present),
    });
    reporter.update();
    expect(reports).toEqual([true]);
    const suspend = listener("suspend");
    const resume = listener("resume");

    suspend();
    expect(reports).toEqual([true, false]);
    resume();
    expect(reports).toEqual([true, false, true]);

    presence = "away";
    updatePowerObservations({ screenLocked: true });
    expect(reports).toEqual([true, false, true, false]);
    presence = "present";
    updatePowerObservations({ screenLocked: false });
    expect(reports).toEqual([true, false, true, false, true]);

    presence = "away";
    updatePowerObservations({ anyWindowFocused: false });
    expect(reports).toEqual([true, false, true, false, true, false]);
    // A power source change says nothing about the person.
    presence = "present";
    updatePowerObservations({ onBattery: true });
    expect(reports).toHaveLength(6);

    reporter.stop();
    expect(powerMonitor.off).toHaveBeenCalledWith("suspend", suspend);
    expect(powerMonitor.off).toHaveBeenCalledWith("resume", resume);
    updatePowerObservations({ anyWindowFocused: true });
    expect(reports).toHaveLength(6);
  });

  it("reports present at least twice inside the client's freshness window, so a lost report can't lapse it", () => {
    expect(PRESENCE_TICK_MS * 2).toBeLessThanOrEqual(PRESENCE_REPORT_MS);
  });
});
