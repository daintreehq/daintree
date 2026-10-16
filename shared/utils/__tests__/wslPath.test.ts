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
    // Names that only start like a device are ordinary.
    expect(wslUncPath("Debian", "/home/console/auxiliary.md")).toBe(
      "\\\\wsl.localhost\\Debian\\home\\console\\auxiliary.md"
    );
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
      // Windows drops a trailing dot or space, naming a different file.
      "/home/dt/report.txt.",
      "/home/dt/report ",
      "/home/dt./x",
      // Device names stay devices, whatever extension follows.
      "/home/dt/CON",
      "/home/dt/nul.txt",
      "/home/dt/com1.log",
      "/home/dt/Lpt9",
    ]) {
      expect(wslUncPath("Ubuntu", path)).toBeNull();
    }
    expect(wslUncPath("-d", "/home")).toBeNull();
    expect(wslUncPath("Ubuntu\\..", "/home")).toBeNull();
  });
});
