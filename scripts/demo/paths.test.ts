import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { claimHarnessDir, demoPaths, loadScene, ownsHarnessDir, takeLooksLive } from "./paths";

let scratch: string;
let previousRoot: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "demo-cli-"));
  previousRoot = process.env.DAINTREE_DEMO_ROOT;
  process.env.DAINTREE_DEMO_ROOT = scratch;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.DAINTREE_DEMO_ROOT;
  else process.env.DAINTREE_DEMO_ROOT = previousRoot;
  rmSync(scratch, { recursive: true, force: true });
});

function writeScene(contents: string): string {
  const file = path.join(scratch, "scene.json");
  writeFileSync(file, contents);
  return file;
}

describe("demoPaths", () => {
  it("keeps harness state out of every directory the scene builder deletes", () => {
    // buildScene wipes `<slug>`, `<slug>-worktrees` and `<slug>-origin.git` on
    // every rebuild. A snapshot inside any of them would be destroyed by the
    // operation a recording session repeats most.
    const paths = demoPaths("intro");
    const destroyed = [
      path.join(scratch, "intro"),
      path.join(scratch, "intro-worktrees"),
      path.join(scratch, "intro-origin.git"),
    ];

    for (const doomed of destroyed) {
      expect(paths.snapshotDir.startsWith(doomed + path.sep)).toBe(false);
      expect(paths.workDir.startsWith(doomed + path.sep)).toBe(false);
      expect(paths.cardPath.startsWith(doomed + path.sep)).toBe(false);
    }
  });

  it("gives the snapshot and the take separate directories", () => {
    // Restoring one onto the other would destroy the golden profile.
    const paths = demoPaths("intro");
    expect(paths.snapshotDir).not.toBe(paths.workDir);
    expect(paths.workDir.startsWith(paths.snapshotDir + path.sep)).toBe(false);
    expect(paths.snapshotDir.startsWith(paths.workDir + path.sep)).toBe(false);
  });

  it("keeps two scenes from sharing harness state", () => {
    const first = demoPaths("intro");
    const second = demoPaths("teaser");
    expect(first.harnessDir).not.toBe(second.harnessDir);
  });

  it("returns absolute paths even when the demo root is relative", () => {
    // Electron resolves --user-data-dir against its own cwd, not ours.
    process.env.DAINTREE_DEMO_ROOT = "relative/demos";
    const paths = demoPaths("intro");
    expect(path.isAbsolute(paths.workDir)).toBe(true);
    expect(path.isAbsolute(paths.snapshotDir)).toBe(true);
  });
});

describe("harness ownership", () => {
  it("refuses a pre-existing directory it did not create", () => {
    // `clean` deletes the whole harness directory and the demo root defaults to
    // C:\Projects on Windows, so a slug matching a real folder must not take it.
    const paths = demoPaths("intro");
    mkdirSync(paths.harnessDir, { recursive: true });
    writeFileSync(path.join(paths.harnessDir, "someones-work.txt"), "real work");

    expect(() => claimHarnessDir(paths)).toThrow(/not a demo harness directory/);
    expect(existsSync(path.join(paths.harnessDir, "someones-work.txt"))).toBe(true);
  });

  it("claims a fresh directory and recognises it afterwards", () => {
    const paths = demoPaths("intro");
    expect(ownsHarnessDir(paths)).toBe(false);

    claimHarnessDir(paths);

    expect(ownsHarnessDir(paths)).toBe(true);
  });

  it("is repeatable, so staging twice does not fail", () => {
    const paths = demoPaths("intro");
    claimHarnessDir(paths);
    expect(() => claimHarnessDir(paths)).not.toThrow();
  });

  it("does not claim ownership of a sibling scene's directory", () => {
    claimHarnessDir(demoPaths("intro"));
    expect(ownsHarnessDir(demoPaths("teaser"))).toBe(false);
  });
});

describe("takeLooksLive", () => {
  it("is false before a take has ever run", () => {
    expect(takeLooksLive(demoPaths("intro"))).toBe(false);
  });

  it("is true while the take profile holds the dirty-exit marker", () => {
    // This is what stops a second take rebuilding the repo underneath a live
    // app — the profile-level refusal fires far too late to prevent that.
    const paths = demoPaths("intro");
    mkdirSync(paths.workDir, { recursive: true });
    writeFileSync(path.join(paths.workDir, "running.lock"), "held");

    expect(takeLooksLive(paths)).toBe(true);
  });
});

describe("loadScene", () => {
  it("names the file when it cannot be read", () => {
    const missing = path.join(scratch, "nope.json");
    expect(() => loadScene(missing)).toThrow(new RegExp(`Cannot read scene file.*nope\\.json`));
  });

  it("names the file and the syntax problem when the JSON is malformed", () => {
    // Scenes are hand-edited throwaway files, so a trailing comma is the most
    // likely failure and the error has to point straight at it.
    const file = writeScene('{ "slug": "intro", }');
    expect(() => loadScene(file)).toThrow(/is not valid JSON/);
    expect(() => loadScene(file)).toThrow(/scene\.json/);
  });

  it("reports scene validation problems rather than failing later", () => {
    const file = writeScene(JSON.stringify({ slug: "Bad Slug", files: {} }));
    let message = "";
    try {
      loadScene(file);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("slug");
    expect(message).toContain("files");
  });

  it("returns the parsed scene and its resolved path", () => {
    const file = writeScene(JSON.stringify({ slug: "intro", files: { "README.md": "# intro\n" } }));
    const result = loadScene(file);

    expect(result.scene.slug).toBe("intro");
    expect(path.isAbsolute(result.scenePath)).toBe(true);
  });
});
