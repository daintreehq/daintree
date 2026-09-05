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

  it("redacts SSH git remotes but keeps the host", () => {
    const result = scrubReportPath("origin git@github.com:acme/secret-repo.git (fetch)");
    expect(result).toBe("origin git@github.com:REDACTED/REDACTED (fetch)");
  });

  it("redacts SSH git remotes without a .git suffix", () => {
    expect(scrubReportPath("git@gitlab.example.com:team/project")).toBe(
      "git@gitlab.example.com:REDACTED/REDACTED"
    );
  });

  it("redacts HTTPS git remotes only when they end in .git", () => {
    expect(scrubReportPath("cloning https://github.com/acme/secret-repo.git now")).toBe(
      "cloning https://github.com/REDACTED/REDACTED.git now"
    );
    expect(scrubReportPath("see https://github.com/acme/secret-repo/issues/1")).toContain(
      "acme/secret-repo"
    );
  });

  it("redacts nested HTTPS git remote paths", () => {
    const result = scrubReportPath("https://git.example.com/group/subgroup/project.git");
    expect(result).toBe("https://git.example.com/REDACTED/REDACTED.git");
  });

  it("redacts SSH remotes with nested groups so the leaf repo cannot leak", () => {
    const result = scrubReportPath("git@gitlab.com:group/subgroup/private-repo.git");
    expect(result).toBe("git@gitlab.com:REDACTED/REDACTED");
    expect(result).not.toContain("private-repo");
  });

  it("redacts authenticated HTTPS remotes", () => {
    const result = scrubReportPath("https://mytoken:x@github.com/acme/private-repo.git");
    expect(result).not.toContain("acme");
    expect(result).not.toContain("private-repo");
    expect(result).toContain("REDACTED/REDACTED.git");
  });

  it("redacts tilde-relative home paths", () => {
    expect(scrubReportPath("cwd: ~/Projects/client-work/app")).toBe("cwd: ~/REDACTED");
    expect(scrubReportPath('{"dir":"~/Projects/secret"}')).toBe('{"dir":"~/REDACTED"}');
  });

  it("does not treat an embedded tilde as a home path", () => {
    expect(scrubReportPath("backup~/file")).toBe("backup~/file");
  });

  it("redacts /tmp and /var/folders paths", () => {
    expect(scrubReportPath("wrote /tmp/daintree-greg-1234/out.log")).toBe("wrote /tmp/REDACTED");
    expect(scrubReportPath("/var/folders/ab/x1y2z3/T/session.sock")).toBe("/var/folders/REDACTED");
    expect(scrubReportPath("/private/tmp/scratch/file")).toBe("/private/tmp/REDACTED");
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
      "git@github.com:acme/secret-repo.git",
      "git@gitlab.com:group/subgroup/private-repo.git",
      "https://github.com/acme/secret-repo.git",
      "https://mytoken:x@github.com/acme/secret-repo.git",
      "~/Projects/client-work",
      "/tmp/daintree-greg-1234/out.log",
      "/var/folders/ab/x1y2z3/T/session.sock",
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

describe("scrubReportPath across a multi-section document", () => {
  // The username classes matched every character but `/`, `"` and `\\` — which
  // includes newlines. A home path at the end of one section therefore ate the
  // rest of the document into the `USER` replacement, silently truncating the
  // very report it was redacting.
  it("stops the username match at the end of its line", () => {
    const report = "Message: /Users/alice\n\nStack:\nkeep me\n\nComponent stack:\nand me";

    const scrubbed = scrubReportPath(report);

    expect(scrubbed).toContain("Message: /Users/USER");
    expect(scrubbed).toContain("keep me");
    expect(scrubbed).toContain("and me");
  });

  it("still redacts a username containing spaces", () => {
    expect(scrubReportPath("/Users/john smith/notes.txt")).toBe("/Users/USER/notes.txt");
    expect(scrubReportPath("C:\\Users\\john smith\\notes.txt")).toBe("C:\\Users\\USER\\notes.txt");
  });

  it("stops a Windows username match at the end of its line", () => {
    const scrubbed = scrubReportPath("Path: C:\\Users\\alice\nStack:\nkeep me");

    expect(scrubbed).toContain("C:\\Users\\USER");
    expect(scrubbed).toContain("keep me");
  });
});
