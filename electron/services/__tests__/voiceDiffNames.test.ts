import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorktreeDiffNames } from "../voiceDiffNames.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type Git = (...args: string[]) => void;

function gitIn(dir: string): Git {
  return (...args) => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
}

/** A repository whose origin/HEAD is its first commit, as a worktree branch sees develop. */
function repo(): { dir: string; git: Git } {
  const dir = tempDir("voice-diff-names-");
  const git = gitIn(dir);
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "base.ts"), "export const startingPoint = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/develop", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  return { dir, git };
}

/** Programs that leave a marker behind when git runs them. */
function spies() {
  const markers = tempDir("voice-diff-spies-");
  const ran = (name: string) => existsSync(path.join(markers, name));
  return {
    ran,
    clean: (name: string) => `sh -c 'touch "${path.join(markers, name)}"; cat'`,
    process: (name: string) => `sh -c 'touch "${path.join(markers, name)}"; exit 1'`,
    textconv: (name: string) => `sh -c 'touch "${path.join(markers, name)}"; cat "$1"' --`,
  };
}

/** A diff the way anything else would run it, with every configured program allowed. */
function plainDiff(dir: string, ...args: string[]): void {
  spawnSync("git", ["diff", ...args], { cwd: dir, stdio: "ignore" });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readWorktreeDiffNames", () => {
  it("reads what the branch's commits and its uncommitted work add since it left the default branch", async () => {
    const { dir, git } = repo();
    writeFileSync(path.join(dir, "spans.ts"), "export function annotateUncertainSpans() {}\n");
    writeFileSync(path.join(dir, "package-lock.json"), '{ "integrityHashFragmentXyz9": 1 }\n');
    git("add", ".");
    git("commit", "-q", "-m", "work");
    writeFileSync(path.join(dir, "base.ts"), "export const modifiedTrackedName = 1;\n");
    writeFileSync(path.join(dir, "staged.ts"), "export const stagedHelperName = 2;\n");
    git("add", "staged.ts");
    writeFileSync(path.join(dir, "untracked.ts"), "export const untrackedFileName = 3;\n");

    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual([
      "modifiedTrackedName",
      "annotateUncertainSpans",
      "stagedHelperName",
    ]);
  });

  it("diffs from where the branch left the default branch, not from where that branch is now", async () => {
    const { dir, git } = repo();
    git("checkout", "-q", "-b", "upstream");
    writeFileSync(path.join(dir, "base.ts"), "export const upstreamRenamedPoint = 1;\n");
    git("commit", "-q", "-am", "upstream moves on");
    git("update-ref", "refs/remotes/origin/develop", "HEAD");
    git("checkout", "-q", "-b", "topic", "HEAD~1");
    writeFileSync(path.join(dir, "spans.ts"), "export function annotateUncertainSpans() {}\n");
    git("add", "spans.ts");

    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual(["annotateUncertainSpans"]);
  });

  it("reads uncommitted work without a default branch to diff against", async () => {
    const { dir, git } = repo();
    git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    writeFileSync(path.join(dir, "spans.ts"), "export function annotateUncertainSpans() {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "work");
    writeFileSync(path.join(dir, "base.ts"), "export const modifiedTrackedName = 1;\n");

    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual(["modifiedTrackedName"]);
  });

  it("reads uncommitted work when the default branch shares no history with it", async () => {
    const { dir, git } = repo();
    const unrelated = execFileSync("git", ["commit-tree", "-m", "unrelated", "HEAD^{tree}"], {
      cwd: dir,
    })
      .toString("utf8")
      .trim();
    git("update-ref", "refs/remotes/origin/develop", unrelated);
    writeFileSync(path.join(dir, "base.ts"), "export const modifiedTrackedName = 1;\n");

    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual(["modifiedTrackedName"]);
  });

  it("reads an edit made since the worktree's last dictation", async () => {
    const { dir } = repo();
    writeFileSync(path.join(dir, "base.ts"), "export function annotateUncertainSpans() {}\n");
    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual(["annotateUncertainSpans"]);

    appendFileSync(path.join(dir, "base.ts"), "export function matchCodeNames() {}\n");
    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual([
      "annotateUncertainSpans",
      "matchCodeNames",
    ]);
  });

  it("never runs a clean or process filter the repository configures", async () => {
    const { dir, git } = repo();
    const spy = spies();
    // `filter=` with no value names a driver too, one whose name is empty.
    writeFileSync(
      path.join(dir, ".gitattributes"),
      "*.ts filter=spy\n*.proc filter=proc\n*.empty filter=\n"
    );
    writeFileSync(path.join(dir, "spans.ts"), "export const filteredBase = 1;\n");
    writeFileSync(path.join(dir, "data.proc"), "x\n");
    writeFileSync(path.join(dir, "notes.empty"), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "filtered files");
    git("update-ref", "refs/remotes/origin/develop", "HEAD");
    git("config", "filter.spy.clean", spy.clean("clean"));
    git("config", "filter.spy.smudge", spy.clean("smudge"));
    git("config", "filter.spy.required", "true");
    git("config", "filter.proc.process", spy.process("process"));
    git("config", "filter..clean", spy.clean("empty-clean"));
    appendFileSync(path.join(dir, "spans.ts"), "export function annotateUncertainSpans() {}\n");
    appendFileSync(path.join(dir, "data.proc"), "y\n");
    appendFileSync(path.join(dir, "notes.empty"), "y\n");
    const index = readFileSync(path.join(dir, ".git", "index"));

    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual(["annotateUncertainSpans"]);
    expect(["clean", "smudge", "process", "empty-clean"].filter(spy.ran)).toEqual([]);
    expect(readFileSync(path.join(dir, ".git", "index")).equals(index)).toBe(true);
    // The filters do run for a diff that allows them, so their silence above means something.
    plainDiff(dir, "HEAD");
    expect(["clean", "process", "empty-clean"].filter(spy.ran)).toEqual([
      "clean",
      "process",
      "empty-clean",
    ]);
  });

  it("never runs a textconv program the repository configures", async () => {
    const { dir, git } = repo();
    const spy = spies();
    git("config", "diff.spy.textconv", spy.textconv("textconv"));
    writeFileSync(path.join(dir, ".gitattributes"), "*.ts diff=spy\n");
    writeFileSync(path.join(dir, "spans.ts"), "export function annotateUncertainSpans() {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "work");
    appendFileSync(path.join(dir, "spans.ts"), "export function matchCodeNames() {}\n");

    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual([
      "annotateUncertainSpans",
      "matchCodeNames",
    ]);
    expect(spy.ran("textconv")).toBe(false);
    plainDiff(dir, "HEAD");
    expect(spy.ran("textconv")).toBe(true);
  });

  it("never runs a filter or textconv program a changed submodule configures", async () => {
    const spy = spies();
    const upstream = repo().dir;
    const { dir, git } = repo();
    // Code-shaped, so a read that let the moved submodule in would name it.
    git("-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "ChangedSubmodule");
    git("commit", "-q", "-m", "add submodule");
    git("update-ref", "refs/remotes/origin/develop", "HEAD");
    const sub = path.join(dir, "ChangedSubmodule");
    const inSub = gitIn(sub);
    inSub("config", "user.email", "test@example.com");
    inSub("config", "user.name", "Test");
    writeFileSync(
      path.join(sub, ".gitattributes"),
      "*.ts filter=spy diff=spy\n*.proc filter=proc\n"
    );
    writeFileSync(path.join(sub, "inner.ts"), "export const innerSubmoduleName = 1;\n");
    writeFileSync(path.join(sub, "data.proc"), "x\n");
    inSub("add", ".");
    inSub("commit", "-q", "-m", "inner");
    inSub("config", "filter.spy.clean", spy.clean("sub-clean"));
    inSub("config", "filter.proc.process", spy.process("sub-process"));
    inSub("config", "diff.spy.textconv", spy.textconv("sub-textconv"));
    git("add", "ChangedSubmodule");
    git("commit", "-q", "-m", "bump submodule");
    // A moved commit and uncommitted edits inside it, and a change beside it.
    // The edits keep each file's size and move its mtime on, so only hashing
    // the content, through its filter, tells status they changed.
    writeFileSync(path.join(sub, "inner.ts"), "export const innerSubmoduleName = 2;\n");
    writeFileSync(path.join(sub, "data.proc"), "y\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(sub, "inner.ts"), later, later);
    utimesSync(path.join(sub, "data.proc"), later, later);
    writeFileSync(path.join(dir, "base.ts"), "export const modifiedTrackedName = 1;\n");

    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual(["modifiedTrackedName"]);
    expect(["sub-clean", "sub-process", "sub-textconv"].filter(spy.ran)).toEqual([]);
    // Checking the submodule for changes runs status inside it, filters on.
    spawnSync("git", ["diff-index", "-p", "--submodule=short", "origin/HEAD", "--"], {
      cwd: dir,
      stdio: "ignore",
    });
    expect(["sub-clean", "sub-process"].filter(spy.ran)).toEqual(["sub-clean", "sub-process"]);
    // Showing it inline runs a diff inside it, textconv on.
    plainDiff(dir, "--submodule=diff", "origin/HEAD");
    expect(spy.ran("sub-textconv")).toBe(true);
  });

  it("reads nothing outside a repository", async () => {
    expect(await readWorktreeDiffNames(tempDir("voice-diff-none-"), 5_000)).toEqual([]);
  });
});
