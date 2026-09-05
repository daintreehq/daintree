import { describe, expect, it } from "vitest";

import { toExecutableBasename } from "../executableBasename.js";

describe("toExecutableBasename", () => {
  it("takes the basename of a POSIX path", () => {
    expect(toExecutableBasename("/opt/homebrew/bin/claude")).toBe("claude");
  });

  it("takes the basename of a Windows path while running on POSIX", () => {
    // path.basename would return the whole string here, which is the reason
    // this splits on both separators itself.
    expect(toExecutableBasename("C:\\Program Files\\Claude\\Claude.exe")).toBe("claude");
  });

  it("lowercases and strips Windows executable extensions", () => {
    expect(toExecutableBasename("C:\\tools\\Git.EXE")).toBe("git");
    expect(toExecutableBasename("C:\\tools\\npm.cmd")).toBe("npm");
    expect(toExecutableBasename("C:\\tools\\build.bat")).toBe("build");
    expect(toExecutableBasename("C:\\tools\\legacy.COM")).toBe("legacy");
    expect(toExecutableBasename("C:\\tools\\probe.ps1")).toBe("probe");
  });

  it("leaves a non-executable extension alone", () => {
    expect(toExecutableBasename("/usr/bin/python3.11")).toBe("python3.11");
  });

  it("trims surrounding whitespace, including the CRLF a PowerShell read carries", () => {
    expect(toExecutableBasename("  C:\\bin\\node.exe\r\n")).toBe("node");
  });

  it("returns null for empty, blank, and separator-only input", () => {
    expect(toExecutableBasename("")).toBeNull();
    expect(toExecutableBasename("   ")).toBeNull();
    expect(toExecutableBasename("/")).toBeNull();
  });

  it("returns null when stripping the extension would leave nothing", () => {
    expect(toExecutableBasename("/tmp/.exe")).toBeNull();
  });

  it("keeps non-ASCII basenames intact", () => {
    expect(toExecutableBasename("/opt/工具/agent.exe")).toBe("agent");
  });
});
