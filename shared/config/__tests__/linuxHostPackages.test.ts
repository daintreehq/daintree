import { describe, expect, it } from "vitest";
import { clipKeepingHostPackagesFix, HOST_PACKAGES_INSTRUCTION } from "../linuxHostPackages.js";

// A machine missing far more libraries than the deb names, as a bare container can be.
const manyNames = Array.from({ length: 80 }, (_, i) => `libmissing-${i}.so.0`).join(", ");
const refused = (names: string) =>
  `Daintree can't start on the host: these libraries it needs aren't installed there: ${names}. ${HOST_PACKAGES_INSTRUCTION}`;
const long = `Daintree on box wasn't started: ${refused(manyNames)}`;

describe("clipKeepingHostPackagesFix", () => {
  it("leaves text that fits as it is, up to the last character", () => {
    expect(clipKeepingHostPackagesFix(long, long.length)).toBe(long);
  });

  it("cuts the words before a refused start's instruction, never the instruction", () => {
    expect(long.length).toBeGreaterThan(1500);
    const clipped = clipKeepingHostPackagesFix(long, 1500);
    expect(clipped.length).toBe(1500);
    expect(clipped.endsWith(`… ${HOST_PACKAGES_INSTRUCTION}`)).toBe(true);
    const kept = clipped.slice(0, -` ${HOST_PACKAGES_INSTRUCTION}`.length - 1);
    expect(long.startsWith(kept)).toBe(true);
  });

  it("keeps an installer's rollback outcome, saying the instruction once, when that fits", () => {
    // hostInstaller.ts withRecovery, with the restored build's own refusal as its note.
    const names = Array.from({ length: 22 }, (_, i) => `libmissing-${i}.so.0`).join(", ");
    const outcome = "The previous build wasn't started again.";
    const message = `${refused(names)}. ${outcome} ${refused(names)}`;
    expect(message.length).toBeGreaterThan(1500);
    const clipped = clipKeepingHostPackagesFix(message, 1500);
    expect(clipped.length).toBeLessThanOrEqual(1500);
    expect(clipped).toContain(outcome);
    expect(clipped.split(HOST_PACKAGES_INSTRUCTION)).toHaveLength(2);
    expect(clipped.endsWith(HOST_PACKAGES_INSTRUCTION)).toBe(true);
  });

  it("keeps the instruction whole with only room for an ellipsis before it", () => {
    const max = HOST_PACKAGES_INSTRUCTION.length + 2;
    expect(clipKeepingHostPackagesFix(long, max)).toBe(`… ${HOST_PACKAGES_INSTRUCTION}`);
  });

  it("cuts other text at the end, keeping its start", () => {
    const other = `start ${"x".repeat(2000)}`;
    const clipped = clipKeepingHostPackagesFix(other, 1500);
    expect(clipped).toBe(`${other.slice(0, 1499)}…`);
  });

  it("cuts at the end where there's no room for the instruction at all", () => {
    expect(clipKeepingHostPackagesFix(long, 100)).toBe(`${long.slice(0, 99)}…`);
    expect(clipKeepingHostPackagesFix(long, 0)).toBe("");
  });
});
