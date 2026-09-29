import { describe, expect, it, vi } from "vitest";
import { migration029 } from "../029-store-tour-progress-per-tour.js";

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      if (value === undefined) throw new TypeError("Use `delete()` to clear values");
      data[key] = value;
    }),
    delete: vi.fn((key: string) => {
      delete data[key];
    }),
    _data: data,
  } as unknown as Parameters<typeof migration029.up>[0] & {
    _data: Record<string, unknown>;
    set: ReturnType<typeof vi.fn>;
  };
}

const onboardingBase = {
  schemaVersion: 2,
  completed: true,
  checklist: { dismissed: true, celebrationShown: false, items: {} },
};

function run(onboarding: Record<string, unknown> | undefined) {
  const data: Record<string, unknown> = onboarding === undefined ? {} : { onboarding };
  const store = makeStoreMock(data);
  migration029.up(store);
  return { store, after: data.onboarding as Record<string, unknown> | undefined };
}

describe("migration029 — tour progress per tour", () => {
  it("has version 29", () => {
    expect(migration029.version).toBe(29);
  });

  it("moves the single tour record to the built-in tour and hoists mute", () => {
    const { after } = run({
      ...onboardingBase,
      tour: { completed: true, dismissed: true, muted: true, lastChapter: 4 },
    });
    expect(after).toEqual({
      ...onboardingBase,
      tours: { daintree: { completed: true, dismissed: true, lastChapter: 4 } },
      tourMuted: true,
    });
    expect("tour" in after!).toBe(false);
  });

  it("keeps a partially watched tour's resume point", () => {
    const { after } = run({
      ...onboardingBase,
      tour: { completed: false, dismissed: false, muted: false, lastChapter: 3 },
    });
    expect(after!.tours).toEqual({
      daintree: { completed: false, dismissed: false, lastChapter: 3 },
    });
    expect(after!.tourMuted).toBe(false);
  });

  it("coerces malformed legacy fields", () => {
    const { after } = run({
      ...onboardingBase,
      tour: { completed: "yes", dismissed: 1, muted: "true", lastChapter: -2 },
    });
    expect(after!.tours).toEqual({
      daintree: { completed: false, dismissed: false, lastChapter: 0 },
    });
    expect(after!.tourMuted).toBe(false);
  });

  it("coerces non-finite legacy chapters to the start", () => {
    for (const lastChapter of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { after } = run({
        ...onboardingBase,
        tour: { completed: false, dismissed: false, muted: false, lastChapter },
      });
      expect(after!.tours).toEqual({
        daintree: { completed: false, dismissed: false, lastChapter: 0 },
      });
    }
  });

  it("replaces a non-object tours value rather than spreading it", () => {
    const { after } = run({
      ...onboardingBase,
      tours: ["garbage"],
      tour: { completed: true, dismissed: false, muted: false, lastChapter: 0 },
    });
    expect(after!.tours).toEqual({
      daintree: { completed: true, dismissed: false, lastChapter: 0 },
    });
  });

  it("drops a non-object legacy record without inventing progress", () => {
    const { after } = run({ ...onboardingBase, tour: "garbage" });
    expect(after).toEqual({ ...onboardingBase, tours: {}, tourMuted: false });
  });

  it("leaves stores without a legacy record untouched", () => {
    const { store, after } = run({ ...onboardingBase, tours: {}, tourMuted: true });
    expect(store.set).not.toHaveBeenCalled();
    expect(after).toEqual({ ...onboardingBase, tours: {}, tourMuted: true });
  });

  it("leaves a store without onboarding untouched", () => {
    const { store, after } = run(undefined);
    expect(store.set).not.toHaveBeenCalled();
    expect(after).toBeUndefined();
  });

  it("keeps plugin tours with dotted ids alongside the migrated record", () => {
    const pluginTour = { completed: true, dismissed: false, lastChapter: 2 };
    const { after } = run({
      ...onboardingBase,
      tours: { "acme.tools.welcome": pluginTour },
      tour: { completed: true, dismissed: false, muted: false, lastChapter: 0 },
    });
    expect(after!.tours).toEqual({
      "acme.tools.welcome": pluginTour,
      daintree: { completed: true, dismissed: false, lastChapter: 0 },
    });
  });

  it("never overwrites progress already recorded for the built-in tour", () => {
    const current = { completed: false, dismissed: false, lastChapter: 5 };
    const { after } = run({
      ...onboardingBase,
      tours: { daintree: current },
      tourMuted: false,
      tour: { completed: true, dismissed: true, muted: true, lastChapter: 0 },
    });
    expect(after!.tours).toEqual({ daintree: current });
    expect(after!.tourMuted).toBe(false);
    expect("tour" in after!).toBe(false);
  });

  it("is a no-op on replay", () => {
    const { after } = run({
      ...onboardingBase,
      tour: { completed: true, dismissed: false, muted: true, lastChapter: 1 },
    });
    const snapshot = structuredClone(after);
    const { store, after: replayed } = run(after);
    expect(store.set).not.toHaveBeenCalled();
    expect(replayed).toEqual(snapshot);
  });
});
