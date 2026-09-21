import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusAdmissionController } from "../StatusAdmissionController.js";

describe("StatusAdmissionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs every request immediately while someone is looking", () => {
    const controller = new StatusAdmissionController();
    const runs: string[] = [];

    for (let i = 0; i < 20; i++) {
      controller.request(`wt-${i}`, () => runs.push(`wt-${i}`));
    }

    expect(runs).toHaveLength(20);
  });

  it("meters attenuated requests and admits the rest as the budget refills", () => {
    const controller = new StatusAdmissionController();
    controller.setAttenuated(true);
    const runs: string[] = [];

    for (let i = 0; i < 9; i++) {
      controller.request(`wt-${i}`, () => runs.push(`wt-${i}`));
    }

    // The burst ceiling, then nothing until the budget refills.
    const admittedInBurst = runs.length;
    expect(admittedInBurst).toBeGreaterThan(0);
    expect(admittedInBurst).toBeLessThan(9);

    vi.advanceTimersByTime(5_000);
    expect(runs.length).toBeGreaterThan(admittedInBurst);

    vi.advanceTimersByTime(60_000);
    // Nothing is dropped: every worktree eventually runs, oldest first.
    expect(runs).toEqual(["wt-0", "wt-1", "wt-2", "wt-3", "wt-4", "wt-5", "wt-6", "wt-7", "wt-8"]);
  });

  it("coalesces repeat requests for the same worktree into one pass", () => {
    const controller = new StatusAdmissionController();
    controller.setAttenuated(true);
    let runs = 0;

    // Drain the initial budget with other worktrees so the one under test has
    // to wait, then hammer it the way a write burst would.
    for (let i = 0; i < 3; i++) controller.request(`filler-${i}`, () => {});
    for (let i = 0; i < 50; i++) controller.request("busy", () => (runs += 1));

    vi.advanceTimersByTime(60_000);

    expect(runs).toBe(1);
  });

  it("releases everything parked the moment the user comes back", () => {
    const controller = new StatusAdmissionController();
    controller.setAttenuated(true);
    const runs: string[] = [];

    for (let i = 0; i < 9; i++) {
      controller.request(`wt-${i}`, () => runs.push(`wt-${i}`));
    }
    const parked = 9 - runs.length;
    expect(parked).toBeGreaterThan(0);

    controller.setAttenuated(false);

    // No timer advance: returning focus must not wait on the budget.
    expect(runs).toHaveLength(9);
  });

  it("forgets a worktree's parked request once it is cancelled", () => {
    const controller = new StatusAdmissionController();
    controller.setAttenuated(true);
    let ran = false;

    for (let i = 0; i < 3; i++) controller.request(`filler-${i}`, () => {});
    controller.request("going-away", () => (ran = true));
    controller.cancel("going-away");

    vi.advanceTimersByTime(60_000);

    expect(ran).toBe(false);
  });
});
