import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { probeResourceConfig } from "../resourceConfigProbe.js";

describe("probeResourceConfig", () => {
  let root: string;
  let home: string;
  let project: string;
  let worktree: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "resource-probe-"));
    home = path.join(root, "home");
    project = path.join(root, "project");
    worktree = path.join(root, "project-feature");
    for (const dir of [home, project, worktree]) mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(dir: string, file: string, content: string) {
    mkdirSync(path.join(dir, ".daintree"), { recursive: true });
    writeFileSync(path.join(dir, ".daintree", file), content);
  }

  const probe = () => probeResourceConfig(project, [worktree], home);

  it("is none when nothing declares a resource", async () => {
    expect(await probe()).toBe("none");
    write(project, "config.json", JSON.stringify({ setup: ["npm install"] }));
    expect(await probe()).toBe("none");
  });

  it.each([
    [
      "the repository config",
      () => write(project, "config.json", '{"resource":{"provision":["x"]}}'),
    ],
    ["a worktree config", () => write(worktree, "config.json", '{"resources":{}}')],
    [
      "the repository settings",
      () => write(project, "settings.json", '{"resourceEnvironments":{"dev":{}}}'),
    ],
    [
      "the user's per-project settings",
      () => {
        const userDir = path.join(
          home,
          ".daintree",
          "projects",
          project.replace(/[/\\:*?"<>|]/g, "_")
        );
        mkdirSync(userDir, { recursive: true });
        writeFileSync(path.join(userDir, "settings.json"), '{"resourceEnvironment":{}}');
      },
    ],
  ])("is configured when %s declares one", async (_where, arrange) => {
    arrange();
    expect(await probe()).toBe("configured");
  });

  it.skipIf(process.platform === "win32")(
    "is unknown when a read stalls past the deadline",
    async () => {
      // A FIFO with no writer blocks its reader, as a hung mount would.
      mkdirSync(path.join(project, ".daintree"), { recursive: true });
      const fifo = path.join(project, ".daintree", "config.json");
      execFileSync("mkfifo", [fifo]);
      expect(await probeResourceConfig(project, [worktree], home, 50)).toBe("unknown");
      // Release the stalled read so it doesn't pin a threadpool slot.
      closeSync(openSync(fifo, "w"));
    }
  );

  it("is unknown when a config file can't be parsed", async () => {
    write(project, "config.json", "{ not json");
    expect(await probe()).toBe("unknown");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "is unknown when a config file can't be read",
    async () => {
      write(project, "settings.json", "{}");
      chmodSync(path.join(project, ".daintree", "settings.json"), 0o000);
      expect(await probe()).toBe("unknown");
    }
  );
});
