import { describe, expect, it } from "vitest";
import {
  isEitherRemoteRoleSupportedOn,
  isRemoteHostSupportedOn,
  isRemoteShellSupportedOn,
  remoteConnectionKindOn,
} from "../remoteHostsSupport.js";

describe("Remote Hosts role gates", () => {
  it("allows both roles on macOS and Linux builds that carry the feature", () => {
    for (const platform of ["darwin", "linux", "posix"]) {
      expect(isRemoteShellSupportedOn(platform, true)).toBe(true);
      expect(isRemoteHostSupportedOn(platform, true)).toBe(true);
      expect(isEitherRemoteRoleSupportedOn(platform, true)).toBe(true);
    }
  });

  it("makes Windows a Shell and never a Host", () => {
    expect(isRemoteShellSupportedOn("win32", true)).toBe(true);
    expect(isRemoteHostSupportedOn("win32", true)).toBe(false);
    expect(isEitherRemoteRoleSupportedOn("win32", true)).toBe(true);
  });

  it("allows neither role in a build without the feature", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      expect(isRemoteShellSupportedOn(platform, false)).toBe(false);
      expect(isRemoteHostSupportedOn(platform, false)).toBe(false);
      expect(isEitherRemoteRoleSupportedOn(platform, false)).toBe(false);
    }
  });

  it("reaches hosts in WSL distros on Windows and over ssh everywhere else", () => {
    expect(remoteConnectionKindOn("win32")).toBe("wsl");
    for (const platform of ["darwin", "linux", "posix"]) {
      expect(remoteConnectionKindOn(platform)).toBe("ssh");
    }
  });
});
