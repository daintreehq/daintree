import { describe, it, expect } from "vitest";
import { isWebGLHardwareAccelerated } from "../../../utils/gpuDetection.js";

describe("isWebGLHardwareAccelerated", () => {
  it('returns true for "enabled"', () => {
    expect(isWebGLHardwareAccelerated("enabled")).toBe(true);
  });

  it('returns true for "enabled_on"', () => {
    expect(isWebGLHardwareAccelerated("enabled_on")).toBe(true);
  });

  it('returns true for "enabled_force"', () => {
    expect(isWebGLHardwareAccelerated("enabled_force")).toBe(true);
  });

  it('returns true for "enabled_force_on"', () => {
    expect(isWebGLHardwareAccelerated("enabled_force_on")).toBe(true);
  });

  it('returns false for "enabled_readback"', () => {
    expect(isWebGLHardwareAccelerated("enabled_readback")).toBe(false);
  });

  it('returns false for "disabled_software"', () => {
    expect(isWebGLHardwareAccelerated("disabled_software")).toBe(false);
  });

  it('returns false for "unavailable_software"', () => {
    expect(isWebGLHardwareAccelerated("unavailable_software")).toBe(false);
  });

  it('returns false for "disabled_off"', () => {
    expect(isWebGLHardwareAccelerated("disabled_off")).toBe(false);
  });

  it('returns false for "unavailable_off"', () => {
    expect(isWebGLHardwareAccelerated("unavailable_off")).toBe(false);
  });

  it("returns true for undefined", () => {
    expect(isWebGLHardwareAccelerated(undefined)).toBe(true);
  });

  it("returns true for null", () => {
    expect(isWebGLHardwareAccelerated(null)).toBe(true);
  });

  it("returns true for non-string value", () => {
    expect(isWebGLHardwareAccelerated(42)).toBe(true);
  });
});
