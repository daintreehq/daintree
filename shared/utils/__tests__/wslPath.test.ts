import { describe, expect, it } from "vitest";
import { wslUncPath } from "../wslPath.js";

describe("wslUncPath", () => {
  it("names a distro's path on WSL's Windows share", () => {
    expect(wslUncPath("Ubuntu-24.04", "/home/dt/project/src/a.ts")).toBe(
      "\\\\wsl.localhost\\Ubuntu-24.04\\home\\dt\\project\\src\\a.ts"
    );
    expect(wslUncPath("Ubuntu 22.04 LTS", "/home/a b/c")).toBe(
      "\\\\wsl.localhost\\Ubuntu 22.04 LTS\\home\\a b\\c"
    );
    expect(wslUncPath("Debian", "/")).toBe("\\\\wsl.localhost\\Debian\\");
    expect(wslUncPath("Debian", "/srv//x/")).toBe("\\\\wsl.localhost\\Debian\\srv\\x");
  });

  it("refuses paths Windows can't name or that would step outside the one meant", () => {
    for (const path of [
      "relative/x",
      "/home/../etc/passwd",
      "/home/./x",
      "/a\\b",
      "/a:b",
      "/a?b",
      "/a*b",
      '/a"b',
      "/a<b",
      "/a|b",
      "/a\nb",
      "/a\0b",
    ]) {
      expect(wslUncPath("Ubuntu", path)).toBeNull();
    }
    expect(wslUncPath("-d", "/home")).toBeNull();
    expect(wslUncPath("Ubuntu\\..", "/home")).toBeNull();
  });
});
