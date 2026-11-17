import { describe, expect, it, vi } from "vitest";
import {
  notificationSettingsWritten,
  onNotificationSettingsWritten,
  sanitizeNotificationSettingsPatch,
} from "../notificationSettingsPatch.js";

const ALLOWED = new Set(["chime.wav", "ping.wav"]);

describe("sanitizeNotificationSettingsPatch", () => {
  it("drops a key it doesn't recognise rather than passing it through", () => {
    const result = sanitizeNotificationSettingsPatch(
      { enabled: true, somethingInvented: "yes" },
      ALLOWED
    );

    expect(result).toEqual({ enabled: true });
  });

  it("drops a field whose type is wrong", () => {
    const result = sanitizeNotificationSettingsPatch({ enabled: "true" }, ALLOWED);
    expect(result).not.toHaveProperty("enabled");
  });

  it("accepts flashEnabled and drops a non-boolean value for it", () => {
    expect(sanitizeNotificationSettingsPatch({ flashEnabled: true }, ALLOWED)).toEqual({
      flashEnabled: true,
    });
    expect(sanitizeNotificationSettingsPatch({ flashEnabled: "true" }, ALLOWED)).not.toHaveProperty(
      "flashEnabled"
    );
  });

  it("drops a sound file that isn't available and keeps one that is", () => {
    const result = sanitizeNotificationSettingsPatch(
      { completedSoundFile: "missing.wav", waitingSoundFile: "ping.wav" },
      ALLOWED
    );

    expect(result).not.toHaveProperty("completedSoundFile");
    expect(result.waitingSoundFile).toBe("ping.wav");
  });

  it("clamps the escalation delay into its supported window", () => {
    const tooSmall = sanitizeNotificationSettingsPatch(
      { waitingEscalationDelayMs: 1 },
      ALLOWED
    ).waitingEscalationDelayMs;
    const tooLarge = sanitizeNotificationSettingsPatch(
      { waitingEscalationDelayMs: Number.MAX_SAFE_INTEGER },
      ALLOWED
    ).waitingEscalationDelayMs;
    const inRange = sanitizeNotificationSettingsPatch(
      { waitingEscalationDelayMs: 60_000 },
      ALLOWED
    ).waitingEscalationDelayMs;

    expect(tooSmall).toBeGreaterThan(1);
    expect(tooLarge).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(tooSmall).toBeLessThanOrEqual(inRange!);
    expect(inRange).toBeLessThanOrEqual(tooLarge!);
    expect(inRange).toBe(60_000);
  });

  it("clamps the sound volume to 0-1 and drops a value that isn't a finite number", () => {
    const volume = (raw: unknown) =>
      sanitizeNotificationSettingsPatch({ soundVolume: raw }, ALLOWED).soundVolume;

    expect(volume(0.35)).toBe(0.35);
    expect(volume(0)).toBe(0);
    expect(volume(4)).toBe(1);
    expect(volume(-0.5)).toBe(0);
    expect(volume(Number.NaN)).toBeUndefined();
    expect(volume(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(volume("0.5")).toBeUndefined();
  });

  it("clamps quiet-hours minutes to a single day and floors fractions", () => {
    const result = sanitizeNotificationSettingsPatch(
      { quietHoursStartMin: -5, quietHoursEndMin: 99_999 },
      ALLOWED
    );

    expect(result.quietHoursStartMin).toBe(0);
    expect(result.quietHoursEndMin).toBe(1439);
    expect(
      sanitizeNotificationSettingsPatch({ quietHoursStartMin: 10.9 }, ALLOWED).quietHoursStartMin
    ).toBe(10);
  });

  it("dedupes, sorts, and filters weekday numbers to real weekdays", () => {
    const result = sanitizeNotificationSettingsPatch(
      { quietHoursWeekdays: [5, 1, 1, 9, -2, 3.5, 0] },
      ALLOWED
    );

    expect(result.quietHoursWeekdays).toEqual([0, 1, 5]);
  });

  it("returns nothing for a non-object patch instead of throwing", () => {
    expect(sanitizeNotificationSettingsPatch(null, ALLOWED)).toEqual({});
    expect(sanitizeNotificationSettingsPatch("nope", ALLOWED)).toEqual({});
  });

  it("only reports back fields it actually accepted, so callers can detect drops", () => {
    const requested = { enabled: true, completedSoundFile: "missing.wav" };
    const result = sanitizeNotificationSettingsPatch(requested, ALLOWED);

    const dropped = Object.keys(requested).filter((key) => !(key in result));
    expect(dropped).toEqual(["completedSoundFile"]);
  });
});

describe("notification settings writes (#17240)", () => {
  it("tells each listener of a write until it unsubscribes, past one that throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const heard = vi.fn();
    const off = onNotificationSettingsWritten(heard);
    const offThrowing = onNotificationSettingsWritten(() => {
      throw new Error("listener broke");
    });
    const after = vi.fn();
    const offAfter = onNotificationSettingsWritten(after);

    notificationSettingsWritten();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);

    off();
    offThrowing();
    offAfter();
    notificationSettingsWritten();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
