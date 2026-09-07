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
    expect(toExecutableBasename("\\")).toBeNull();
    expect(toExecutableBasename("C:\\")).toBeNull();
  });

  it("returns null for a directory path rather than the directory's own name", () => {
    // A trailing separator used to fall back to the whole path, so
    // "/some/directory/" reported itself as an executable basename.
    expect(toExecutableBasename("/some/directory/")).toBeNull();
    expect(toExecutableBasename("C:\\Program Files\\Claude\\")).toBeNull();
  });

  it("returns null when stripping the extension would leave nothing", () => {
    expect(toExecutableBasename("/tmp/.exe")).toBeNull();
  });

  it("keeps a non-ASCII basename intact rather than stripping it", () => {
    // Unicode in the DIRECTORY proves nothing — it is discarded either way.
    expect(toExecutableBasename("/opt/tools/工具.exe")).toBe("工具");
    expect(toExecutableBasename("C:\\Programme\\Übersetzer.exe")).toBe("übersetzer");
  });
});
