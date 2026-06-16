import { describe, it, expect } from "vitest";
import { localAuthStubs } from "../forgeProviderHelpers.js";

describe("localAuthStubs (#10563)", () => {
  it("getCredentials resolves null (no stored credentials)", async () => {
    await expect(localAuthStubs.getCredentials()).resolves.toBeNull();
  });

  it("validateCredentials resolves valid", async () => {
    await expect(localAuthStubs.validateCredentials()).resolves.toEqual({ valid: true });
  });

  it("validateToken resolves valid for any token", async () => {
    await expect(localAuthStubs.validateToken("")).resolves.toEqual({ valid: true });
    await expect(localAuthStubs.validateToken("anything")).resolves.toEqual({ valid: true });
  });

  it("can be spread into an impl without overwriting other methods", () => {
    const parseRemote = () => null;
    const impl = { ...localAuthStubs, parseRemote };
    expect(impl.getCredentials).toBe(localAuthStubs.getCredentials);
    expect(impl.parseRemote).toBe(parseRemote);
  });
});
