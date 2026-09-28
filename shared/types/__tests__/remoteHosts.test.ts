import { describe, expect, it } from "vitest";
import {
  LOCAL_HOST_ID,
  REMOTE_PROTOCOL_VERSION,
  compareHandshake,
  isValidRemoteHostId,
  parseHostScopedKey,
  toHostScopedKey,
  type HostHandshakeInfo,
} from "../remoteHosts.js";

const base: HostHandshakeInfo = {
  version: "0.38.0",
  commit: "abc",
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  platform: "darwin",
  arch: "arm64",
};

describe("host-scoped keys", () => {
  it("leaves local project ids bare so nothing keyed today changes", () => {
    expect(toHostScopedKey(LOCAL_HOST_ID, "a1b2")).toBe("a1b2");
    expect(toHostScopedKey(null, "a1b2")).toBe("a1b2");
    expect(parseHostScopedKey("a1b2")).toEqual({ hostId: LOCAL_HOST_ID, projectId: "a1b2" });
  });

  it("rejects host ids that would not round-trip", () => {
    for (const bad of ["a:b", " x", "-x", "x".repeat(65)]) {
      expect(() => toHostScopedKey(bad, "p")).toThrow(/Invalid host id/);
    }
    expect(isValidRemoteHostId("local")).toBe(false);
    expect(isValidRemoteHostId("")).toBe(false);
    expect(isValidRemoteHostId("studio-01.tail")).toBe(true);
  });

  it("prefixes remote ids and round-trips them", () => {
    const key = toHostScopedKey("studio-01", "a1b2");
    expect(key).toBe("studio-01:a1b2");
    expect(parseHostScopedKey(key)).toEqual({ hostId: "studio-01", projectId: "a1b2" });
  });
});

describe("compareHandshake", () => {
  it("accepts the same build on a different platform and arch", () => {
    expect(compareHandshake(base, { ...base, platform: "linux", arch: "x64" })).toBeNull();
  });

  it("reports protocol, version and commit mismatches in that order", () => {
    expect(compareHandshake(base, { ...base, protocolVersion: 99, version: "1" })).toMatchObject({
      kind: "protocol",
    });
    expect(compareHandshake(base, { ...base, version: "0.39.0" })).toMatchObject({
      kind: "version",
    });
    expect(compareHandshake(base, { ...base, commit: "def" })).toMatchObject({ kind: "commit" });
  });
});
