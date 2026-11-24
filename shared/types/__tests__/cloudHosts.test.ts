import { describe, expect, it } from "vitest";
import {
  cloudMachineIsBilling,
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
