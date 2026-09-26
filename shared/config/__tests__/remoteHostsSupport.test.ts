import { describe, expect, it } from "vitest";
import {
  isEitherRemoteRoleSupportedOn,
  isRemoteHostSupportedOn,
  isRemoteShellSupportedOn,
} from "../remoteHostsSupport.js";

describe("Remote Hosts role gates", () => {
  it("allows both roles on macOS and Linux builds that carry the feature", () => {
    for (const platform of ["darwin", "linux", "posix"]) {
      expect(isRemoteShellSupportedOn(platform, true)).toBe(true);
      expect(isRemoteHostSupportedOn(platform, true)).toBe(true);
      expect(isEitherRemoteRoleSupportedOn(platform, true)).toBe(true);
    }
  });

  it("allows neither role on Windows, nor in a build without the feature", () => {
    expect(isRemoteShellSupportedOn("win32", true)).toBe(false);
    expect(isRemoteHostSupportedOn("win32", true)).toBe(false);
    expect(isEitherRemoteRoleSupportedOn("win32", true)).toBe(false);
    for (const platform of ["darwin", "linux"]) {
      expect(isRemoteShellSupportedOn(platform, false)).toBe(false);
      expect(isRemoteHostSupportedOn(platform, false)).toBe(false);
      expect(isEitherRemoteRoleSupportedOn(platform, false)).toBe(false);
    }
  });
});
