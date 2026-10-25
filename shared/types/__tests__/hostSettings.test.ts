import { describe, expect, it } from "vitest";
import { HostSettingsPatchSchema, hostSettingRefusal } from "../hostSettings.js";

describe("hostSettings canopyModel", () => {
  it("takes only one of Canopy's published models, refusing anything a host would refuse", () => {
    expect(hostSettingRefusal("canopyModel", "daintreehq/canopy-reader-68m")).toBeNull();
    for (const value of [
      "someone/canopy-reader-68m",
      "daintreehq/canopy-reader-../../x",
      "daintreehq/other",
      null,
      7,
    ]) {
      expect(hostSettingRefusal("canopyModel", value)).not.toBeNull();
    }
  });

  it("parses a patch that changes the model, and rejects one naming another repo", () => {
    expect(
      HostSettingsPatchSchema.safeParse({ canopyModel: "daintreehq/canopy-reader-68m" }).success
    ).toBe(true);
    expect(HostSettingsPatchSchema.safeParse({ canopyModel: "evil/model" }).success).toBe(false);
  });
});
