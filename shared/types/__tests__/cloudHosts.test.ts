import { describe, expect, it } from "vitest";
import {
  cloudChoiceFitsLocation,
  cloudLocationsFrom,
  cloudMachineIsBilling,
  cloudMachineTypeLocationReason,
  cloudProviderNamespace,
  isCloudProviderId,
  pluginCloudProviderId,
} from "../cloudHosts.js";

describe("cloud provider ids", () => {
  it("reads a bare name as a built-in, registered or not", () => {
    expect(cloudProviderNamespace("boat")).toEqual({ kind: "built-in" });
    expect(cloudProviderNamespace("agent37")).toEqual({ kind: "built-in" });
    expect(cloudProviderNamespace("aws-ec2")).toEqual({ kind: "built-in" });
  });

  it("reads a three-part id as a provider inside that plugin's namespace", () => {
    expect(cloudProviderNamespace("acme.clouds.ec2")).toEqual({
      kind: "plugin",
      pluginId: "acme.clouds",
    });
    expect(cloudProviderNamespace("daintree.gcp.compute-engine")).toEqual({
      kind: "plugin",
      pluginId: "daintree.gcp",
    });
  });

  it("refuses anything of neither shape", () => {
    for (const value of [
      "",
      " boat",
      "boat ",
      "Boat",
      "boat.",
      ".boat",
      "acme.boat",
      "a.b.c.d",
      "acme..boat",
      "acme.clouds.",
      "acme.clouds.EC2",
      "-boat",
      "boat-",
      "bo--at",
      "acme:clouds:ec2",
      "acme/clouds/ec2",
      "x".repeat(33),
      `acme.clouds.${"x".repeat(33)}`,
      `${"a".repeat(31)}.${"b".repeat(32)}.${"c".repeat(33)}`,
      `${"a".repeat(32)}.${"b".repeat(32)}.ec2`,
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isCloudProviderId(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("accepts the longest names either shape allows", () => {
    expect(isCloudProviderId("x".repeat(32))).toBe(true);
    expect(isCloudProviderId(`${"a".repeat(31)}.${"b".repeat(32)}.${"c".repeat(32)}`)).toBe(true);
  });

  it("never lets a plugin's id take a built-in's shape", () => {
    expect(pluginCloudProviderId("acme.clouds", "boat")).toBe("acme.clouds.boat");
    expect(cloudProviderNamespace(pluginCloudProviderId("acme.clouds", "boat"))).toEqual({
      kind: "plugin",
      pluginId: "acme.clouds",
    });
    expect(pluginCloudProviderId("acme", "boat")).toBeNull();
    expect(pluginCloudProviderId("", "boat")).toBeNull();
  });

  it("refuses a provider name that would reach into another namespace", () => {
    expect(pluginCloudProviderId("acme.clouds", "other.ec2")).toBeNull();
    // A well-formed id, but inside acme.clouds rather than the acme it was asked for.
    expect(pluginCloudProviderId("acme", "clouds.ec2")).toBeNull();
    expect(pluginCloudProviderId("acme.clouds", "")).toBeNull();
    expect(pluginCloudProviderId("acme.clouds", "EC2")).toBeNull();
    expect(pluginCloudProviderId("acme.clouds.extra", "ec2")).toBeNull();
  });
});

describe("cloudMachineIsBilling (#17346)", () => {
  it("bills a stopped machine only where the provider declares it does", () => {
    expect(cloudMachineIsBilling("stopped", { stoppedComputeBilled: false })).toBe(false);
    expect(cloudMachineIsBilling("stopped", { stoppedComputeBilled: true })).toBe(true);
    for (const declared of [false, true]) {
      const persistence = { stoppedComputeBilled: declared };
      expect(cloudMachineIsBilling("running", persistence)).toBe(true);
      expect(cloudMachineIsBilling("deleted", persistence)).toBe(false);
      expect(cloudMachineIsBilling("unknown", persistence)).toBeNull();
    }
  });
});

describe("sizes tied to locations (#18189)", () => {
  const regions = {
    label: "Region",
    defaultId: "us",
    choices: [
      {
        id: "us",
        label: "United States",
        description: null,
        available: true,
        reason: null,
        locations: null,
      },
      {
        id: "eu",
        label: "Europe",
        description: null,
        available: true,
        reason: null,
        locations: null,
      },
    ],
  };

  it("fits a size anywhere unless it names locations, and a named list needs one of them", () => {
    expect(cloudChoiceFitsLocation({}, null)).toBe(true);
    expect(cloudChoiceFitsLocation({ locations: null }, "eu")).toBe(true);
    expect(cloudChoiceFitsLocation({ locations: ["us"] }, "us")).toBe(true);
    expect(cloudChoiceFitsLocation({ locations: ["us"] }, "eu")).toBe(false);
    expect(cloudChoiceFitsLocation({ locations: ["us"] }, null)).toBe(false);
    expect(cloudChoiceFitsLocation({ locations: [] }, "us")).toBe(false);
  });

  it("says why a size can't go where it was asked, in the location's own words", () => {
    expect(cloudMachineTypeLocationReason({ locations: ["us"] }, regions, "us")).toBeNull();
    expect(cloudMachineTypeLocationReason({}, regions, null)).toBeNull();
    expect(cloudMachineTypeLocationReason({ locations: ["us"] }, regions, "eu")).toBe(
      "not offered in Europe"
    );
    expect(cloudMachineTypeLocationReason({ locations: ["us", "eu"] }, regions, null)).toBe(
      "choose United States or Europe to use it"
    );
    expect(cloudMachineTypeLocationReason({ locations: [] }, regions, "us")).toBe(
      "not offered in any region"
    );
    // A location the catalog doesn't list is named by its id.
    expect(cloudMachineTypeLocationReason({ locations: ["us"] }, regions, "mars")).toBe(
      "not offered in mars"
    );
  });

  it("reads a location list that arrives as data, narrowing what doesn't read", () => {
    expect(cloudLocationsFrom(undefined)).toBeNull();
    expect(cloudLocationsFrom(null)).toBeNull();
    expect(cloudLocationsFrom(["us", 3, "eu"])).toEqual(["us", "eu"]);
    expect(cloudLocationsFrom("us")).toEqual([]);
    expect(cloudLocationsFrom({ us: true })).toEqual([]);
  });
});
