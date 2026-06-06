import { describe, it, expect } from "vitest";
import { scrubReportPath, scrubReportText } from "../reportScrubbers.js";

describe("scrubReportPath", () => {
  it("redacts macOS user paths", () => {
    expect(scrubReportPath("/Users/alice/project/file.ts")).toBe("/Users/USER/project/file.ts");
  });

  it("redacts Linux user paths", () => {
    expect(scrubReportPath("/home/bob/code/x.ts")).toBe("/home/USER/code/x.ts");
  });

  it("redacts a bare user path at the end of a string", () => {
    expect(scrubReportPath('{"cwd":"/Users/alice"}')).toBe('{"cwd":"/Users/USER"}');
    expect(scrubReportPath("cwd=/home/bob")).toBe("cwd=/home/USER");
  });

  it("redacts Windows C-drive backslash paths", () => {
    const result = scrubReportPath("C:\\Users\\Carol\\app\\x.ts");
    expect(result).toBe("C:\\Users\\USER\\app\\x.ts");
    expect(result).not.toContain("Carol");
  });

  it("redacts Windows user profiles on non-C drives", () => {
    expect(scrubReportPath("D:\\Users\\alice\\repo")).toBe("D:\\Users\\USER\\repo");
    expect(scrubReportPath("E:\\Users\\bob\\repo")).not.toContain("bob");
    expect(scrubReportPath("D:/Users/alice/repo")).toBe("D:/Users/USER/repo");
  });

  it("redacts Windows non-C drives inside JSON-stringified text", () => {
    const json = JSON.stringify({ cwd: "D:\\Users\\carol\\repo" });
    const result = scrubReportPath(json);
    expect(result).not.toContain("carol");
    expect(result).toContain("USER");
  });

  it("does not match an invalid (non-letter) drive", () => {
    expect(scrubReportPath("1:\\Users\\alice\\repo")).toContain("alice");
  });

  it("redacts WSL UNC paths (wsl$ prefix)", () => {
    const result = scrubReportPath("\\\\wsl$\\Ubuntu\\home\\alice\\project");
    expect(result).not.toContain("alice");
    expect(result).toContain("Ubuntu");
    expect(result).toContain("home\\USER");
  });

  it("redacts WSL UNC paths (wsl.localhost prefix)", () => {
    const result = scrubReportPath("\\\\wsl.localhost\\Debian\\home\\bob\\src");
    expect(result).not.toContain("bob");
    expect(result).toContain("Debian");
  });

  it("redacts JSON-doubled WSL UNC paths", () => {
    const json = JSON.stringify({ cwd: "\\\\wsl$\\Ubuntu\\home\\alice\\project" });
    const result = scrubReportPath(json);
    expect(result).not.toContain("alice");
    expect(result).toContain("Ubuntu");
  });

  it("redacts JSON-doubled WSL localhost paths", () => {
    const json = JSON.stringify({ cwd: "\\\\wsl.localhost\\Ubuntu\\home\\carol" });
    const result = scrubReportPath(json);
    expect(result).not.toContain("carol");
  });

  it("leaves paths without a username unchanged", () => {
    expect(scrubReportPath("/usr/local/lib/node_modules/foo")).toBe(
      "/usr/local/lib/node_modules/foo"
    );
  });

  it("handles multiple occurrences", () => {
    expect(scrubReportPath("/Users/alice/foo and /Users/bob/bar")).toBe(
      "/Users/USER/foo and /Users/USER/bar"
    );
  });

  it("is idempotent across all path shapes", () => {
    const inputs = [
      "/Users/alice/project",
      "/home/bob/code",
      "C:\\Users\\Carol\\app",
      "D:\\Users\\dave\\repo",
      "\\\\wsl$\\Ubuntu\\home\\alice\\project",
      "\\\\wsl.localhost\\Debian\\home\\bob",
      JSON.stringify({ cwd: "\\\\wsl$\\Ubuntu\\home\\alice" }),
    ];
    for (const input of inputs) {
      const once = scrubReportPath(input);
      expect(scrubReportPath(once)).toBe(once);
    }
  });
});

describe("scrubReportText", () => {
  it("scrubs both secrets and user paths in WSL UNC text", () => {
    const result = scrubReportText(
      "ENOENT at \\\\wsl$\\Ubuntu\\home\\alice with token ghp_0123456789012345678901234567890123456789"
    );
    expect(result).not.toContain("alice");
    expect(result).not.toContain("ghp_0123456789");
  });
});
