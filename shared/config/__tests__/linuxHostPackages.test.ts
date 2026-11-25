import { describe, expect, it } from "vitest";
import { clipKeepingHostPackagesFix, HOST_PACKAGES_INSTRUCTION } from "../linuxHostPackages.js";

// A machine missing far more libraries than the deb names, as a bare container can be.
const names = Array.from({ length: 80 }, (_, i) => `libmissing-${i}.so.0`).join(", ");
const refusal = `Daintree on box wasn't started: Daintree can't start on box: these libraries it needs aren't installed there: ${names}. ${HOST_PACKAGES_INSTRUCTION}`;

describe("clipKeepingHostPackagesFix", () => {
  it("leaves text that fits as it is", () => {
    expect(clipKeepingHostPackagesFix("short", 10)).toBe("short");
  });

  it("cuts the words before a refused start's instruction, never the instruction", () => {
    expect(refusal.length).toBeGreaterThan(1500);
    const clipped = clipKeepingHostPackagesFix(refusal, 1500);
    expect(clipped.length).toBeLessThanOrEqual(1500);
    expect(clipped.endsWith(`… ${HOST_PACKAGES_INSTRUCTION}`)).toBe(true);
    expect(clipped.startsWith("Daintree on box wasn't started: Daintree can't start on box:")).toBe(
      true
    );
  });

  it("drops what came after the instruction rather than cutting into it", () => {
    const clipped = clipKeepingHostPackagesFix(
      `${refusal}. The previous build was put back.`,
      1500
    );
    expect(clipped.endsWith(HOST_PACKAGES_INSTRUCTION)).toBe(true);
  });

  it("cuts other text at the end, as before", () => {
    const other = "x".repeat(2000);
    const clipped = clipKeepingHostPackagesFix(other, 1500);
    expect(clipped.length).toBe(1500);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("cuts at the end where there's no room for the instruction at all", () => {
    const clipped = clipKeepingHostPackagesFix(refusal, 100);
    expect(clipped.length).toBe(100);
    expect(clipped).not.toContain("apt-get");
  });
});
