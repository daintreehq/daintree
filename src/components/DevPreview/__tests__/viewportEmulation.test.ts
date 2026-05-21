import { describe, it, expect } from "vitest";
import { buildEmulationParams } from "../viewportEmulation";

describe("buildEmulationParams", () => {
  it("returns null when no preset is active", () => {
    expect(buildEmulationParams(undefined, false, 1)).toBeNull();
  });

  it("builds iPhone portrait params", () => {
    const params = buildEmulationParams("iphone", false, 2);
    expect(params).not.toBeNull();
    expect(params!.screenPosition).toBe("mobile");
    expect(params!.screenSize).toEqual({ width: 393, height: 852 });
    expect(params!.viewSize).toEqual({ width: 393, height: 852 });
    expect(params!.viewPosition).toEqual({ x: 0, y: 0 });
    expect(params!.deviceScaleFactor).toBe(2);
    expect(params!.scale).toBe(1);
  });

  it("builds iPhone landscape params with rotated=true", () => {
    const params = buildEmulationParams("iphone", true, 3);
    expect(params!.screenSize).toEqual({ width: 852, height: 393 });
    expect(params!.viewSize).toEqual({ width: 852, height: 393 });
    expect(params!.deviceScaleFactor).toBe(3);
  });

  it("builds Galaxy S25 portrait params", () => {
    const params = buildEmulationParams("galaxy", false, 1);
    expect(params!.screenSize).toEqual({ width: 360, height: 780 });
    expect(params!.viewSize).toEqual({ width: 360, height: 780 });
  });

  it("builds iPad Air M3 params", () => {
    const params = buildEmulationParams("ipad", false, 1);
    expect(params!.screenSize).toEqual({ width: 820, height: 1180 });
  });
});
