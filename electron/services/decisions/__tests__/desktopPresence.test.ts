import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ powerMonitor: { on: vi.fn(), off: vi.fn() } }));

import type { UserPresence } from "../../userPresence.js";
import { DesktopPresence, PRESENCE_TICK_MS, type PresenceWatchers } from "../desktopPresence.js";

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
    h.presenceReporter.start();
    expect(h.reports).toEqual([true]);
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    expect(h.reports).toEqual([true, true, true]);
    h.presenceReporter.stop();
  });

  it.each(["away", "unknown"] as const)("reports %s as away, once", (presence) => {
    const h = harness("present");
    h.presenceReporter.start();
    h.set(presence);
    vi.advanceTimersByTime(PRESENCE_TICK_MS * 3);
    expect(h.reports).toEqual([true, false]);
    h.presenceReporter.stop();
  });

  it("reports away first when the person isn't there at start, and nothing more while they stay away", () => {
    const h = harness("unknown");
    h.presenceReporter.start();
    vi.advanceTimersByTime(PRESENCE_TICK_MS * 2);
    expect(h.reports).toEqual([false]);
    h.presenceReporter.stop();
  });

  it("reports present again as soon as a change says the person is back", () => {
    const h = harness("away");
    h.presenceReporter.start();
    h.set("present");
    h.change();
    expect(h.reports).toEqual([false, true]);
    h.presenceReporter.stop();
  });

  it("reports nothing present while it isn't allowed, ending a lease once when it stops being", () => {
    const h = harness("present");
    h.allow(false);
    h.presenceReporter.start();
    vi.advanceTimersByTime(PRESENCE_TICK_MS * 2);
    expect(h.reports).toEqual([false]);

    h.allow(true);
    h.presenceReporter.refresh();
    expect(h.reports).toEqual([false, true]);

    h.allow(false);
    h.presenceReporter.refresh();
    vi.advanceTimersByTime(PRESENCE_TICK_MS * 2);
    expect(h.reports).toEqual([false, true, false]);
    h.presenceReporter.stop();
  });

  it("is away from suspend until resume, whatever the idle state says", () => {
    const h = harness("present");
    h.presenceReporter.start();
    h.suspend();
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    expect(h.reports).toEqual([true, false]);
    h.resume();
    expect(h.reports).toEqual([true, false, true]);
    h.presenceReporter.stop();
  });

  it("ends the lease it started on stop, then reads and listens no more", () => {
    const h = harness("present");
    h.presenceReporter.start();
    expect(h.watching()).toBe(3);
    h.presenceReporter.stop();
    expect(h.reports).toEqual([true, false]);
    expect(h.watching()).toBe(0);
    vi.advanceTimersByTime(PRESENCE_TICK_MS * 3);
    h.presenceReporter.refresh();
    expect(h.reports).toEqual([true, false]);
  });

  it("sends nothing on stop when it last reported away", () => {
    const h = harness("away");
    h.presenceReporter.start();
    h.presenceReporter.stop();
    expect(h.reports).toEqual([false]);
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
    presence.start();
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    expect(report).toHaveBeenCalledTimes(2);
    presence.stop();
    warn.mockRestore();
  });
});
