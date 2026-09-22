import { describe, expect, it } from "vitest";

import { checkPluginEngineRange } from "../pluginEngineCompat.js";

describe("checkPluginEngineRange", () => {
  it.each([
    ["0.7.5", "^0.7.0"],
    ["0.7.5", ">=0.7.0"],
    ["0.7.5", "*"],
    ["0.7.5", "0.7.5"],
    ["0.7.1-rc.1", "^0.7.0"],
  ])("accepts %s against %s", (appVersion, range) => {
    expect(checkPluginEngineRange(appVersion, range)).toBeNull();
  });

  it("accepts a dev build against a range its release satisfies (#12589)", () => {
    expect(checkPluginEngineRange("0.37.0-dev.20260922", ">=0.37.0")).toBeNull();
    expect(checkPluginEngineRange("0.7.0-rc.1", ">=0.7.0")).toBeNull();
  });

  it("still flags a dev build its release would not satisfy", () => {
    expect(checkPluginEngineRange("0.38.0-dev.1", "^0.37.0")).toBe("app-too-new");
  });

  it("still accepts a dev build under an upper bound its release would exceed", () => {
    expect(checkPluginEngineRange("0.38.0-dev.1", "<0.38.0")).toBeNull();
  });

  it("reports app-too-old when the running version is below the range", () => {
    expect(checkPluginEngineRange("0.37.0", ">=0.38.0")).toBe("app-too-old");
    expect(checkPluginEngineRange("0.37.0-dev.1", ">=0.38.0")).toBe("app-too-old");
    expect(checkPluginEngineRange("0.7.4", "0.7.5")).toBe("app-too-old");
  });

  it("reports app-too-new when the running version is above the range", () => {
    expect(checkPluginEngineRange("0.37.0", "^0.11.0")).toBe("app-too-new");
    expect(checkPluginEngineRange("0.8.0", "^0.7.0")).toBe("app-too-new");
  });

  it("reports outside-range for a gap in a disjoint range", () => {
    expect(checkPluginEngineRange("0.37.0", "0.36.0 || 0.38.0")).toBe("outside-range");
  });

  it("reports outside-range for a range no version can satisfy", () => {
    expect(checkPluginEngineRange("0.39.0", ">=0.38.0 <0.38.0")).toBe("outside-range");
    expect(checkPluginEngineRange("0.37.0", "<0.38.0 >=0.38.0")).toBe("outside-range");
  });

  it("reads a nightly whose short SHA isn't strict semver as its release", () => {
    const nightly = "0.37.0-nightly.20260922120000.0123456";
    expect(checkPluginEngineRange(nightly, ">=0.37.0")).toBeNull();
    expect(checkPluginEngineRange(nightly, ">=0.38.0")).toBe("app-too-old");
    expect(checkPluginEngineRange(nightly, "^0.36.0")).toBe("app-too-new");
  });

  it("reports outside-range rather than throwing on an unparseable app version", () => {
    expect(checkPluginEngineRange("not-a-version", ">=0.37.0")).toBe("outside-range");
  });

  it("reports outside-range rather than throwing when a range overflows a version", () => {
    expect(checkPluginEngineRange("0.37.0", "0.0.0 - 0.0.9007199254740991")).toBe("outside-range");
  });
});
