import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildSubmoduleDeleteRisk,
  parseGitmodulesConfig,
  parseIndexGitlinks,
  parseSubmoduleSubStates,
  parseTreeGitlinks,
  resolveModuleGitDir,
} from "../submoduleInventory.js";

const NUL = "\0";

/** Build NUL-terminated output the way git emits it (terminator, not separator). */
function framed(...records: string[]): string {
  return records.map((record) => `${record}${NUL}`).join("");
}

describe("parseIndexGitlinks", () => {
  it("keeps only gitlinks and drops blobs", () => {
    const stdout = framed(
      "100644 aceeb0f49c3de246ac85b1f86b9a73f0d6e3ab0c 0\t.gitmodules",
      "160000 f1d8402c6bb2266e199a4d99159900189160ddea 0\tvendor/lib",
      "100755 1a9cc2b7fbfa834924f4c03780d767ccbecf0c9c 0\tscript.sh"
    );
    expect(parseIndexGitlinks(stdout).map((entry) => entry.path)).toEqual(["vendor/lib"]);
  });

  it("preserves every conflict stage for one path", () => {
    const stdout = framed(
      "160000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\tvendor/lib",
      "160000 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2\tvendor/lib",
      "160000 cccccccccccccccccccccccccccccccccccccccc 3\tvendor/lib"
    );
    const parsed = parseIndexGitlinks(stdout);
    expect(parsed.map((entry) => entry.stage)).toEqual([1, 2, 3]);
    expect(new Set(parsed.map((entry) => entry.path)).size).toBe(1);
    expect(parsed[1].oid).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("survives paths containing spaces, tabs, newlines and backslashes", () => {
    const nasty = "ven dor/li\tb\nnext\\dir";
    const stdout = framed(`160000 f1d8402c6bb2266e199a4d99159900189160ddea 0\t${nasty}`);
    expect(parseIndexGitlinks(stdout)[0].path).toBe(nasty);
  });

  it("ignores malformed records rather than emitting partial entries", () => {
    const stdout = framed(
      "160000 f1d8402c6bb2266e199a4d99159900189160ddea 0",
      "160000 f1d8402c6bb2266e199a4d99159900189160ddea 9\tvendor/bad-stage",
      "160000 f1d8402c6bb2266e199a4d99159900189160ddea 0\t",
      "160000 f1d8402c6bb2266e199a4d99159900189160ddea 0\tvendor/ok"
    );
    expect(parseIndexGitlinks(stdout).map((entry) => entry.path)).toEqual(["vendor/ok"]);
  });
});

describe("parseTreeGitlinks", () => {
  it("reads the OID from the third metadata field, not the second", () => {
    const stdout = framed(
      "100644 blob 1a9cc2b7fbfa834924f4c03780d767ccbecf0c9c\tp.txt",
      "160000 commit f1d8402c6bb2266e199a4d99159900189160ddea\tvendor/lib"
    );
    const parsed = parseTreeGitlinks(stdout);
    expect([...parsed.keys()]).toEqual(["vendor/lib"]);
    expect(parsed.get("vendor/lib")).toBe("f1d8402c6bb2266e199a4d99159900189160ddea");
  });
});

describe("parseSubmoduleSubStates", () => {
  const oid = "f1d8402c6bb2266e199a4d99159900189160ddea";

  it("decodes each sub-state flag independently", () => {
    const stdout = framed(
      "# branch.oid b398f82cb2df94f90e443a5229bafabeb052afcf",
      "# branch.head wt1",
      `1 .M S.M. 160000 160000 160000 ${oid} ${oid} a/dirty`,
      `1 .M S..U 160000 160000 160000 ${oid} ${oid} b/untracked`,
      `1 .M SC.. 160000 160000 160000 ${oid} ${oid} c/moved`,
      `1 .M SCMU 160000 160000 160000 ${oid} ${oid} d/all`
    );
    const states = parseSubmoduleSubStates(stdout);
    expect(states.get("a/dirty")).toEqual({
      commitChanged: false,
      modifiedContent: true,
      untrackedContent: false,
      conflicted: false,
    });
    expect(states.get("b/untracked")?.untrackedContent).toBe(true);
    expect(states.get("b/untracked")?.modifiedContent).toBe(false);
    expect(states.get("c/moved")?.commitChanged).toBe(true);
    expect(states.get("d/all")).toEqual({
      commitChanged: true,
      modifiedContent: true,
      untrackedContent: true,
      conflicted: false,
    });
  });

  it("ignores non-submodule records", () => {
    const stdout = framed(
      `1 .M N... 100644 100644 100644 ${oid} ${oid} src/main.c`,
      "? untracked.txt",
      "! ignored.txt"
    );
    expect(parseSubmoduleSubStates(stdout).size).toBe(0);
  });

  it("consumes the origin-path token of a rename record so later records stay aligned", () => {
    // The origin path is itself a syntactically valid submodule record. A
    // parser that does not consume it would read it as one and invent an entry.
    const decoy = `1 .M S.M. 160000 160000 160000 ${oid} ${oid} decoy/path`;
    const stdout = framed(
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 renamed p.txt`,
      decoy,
      `1 .M SCMU 160000 160000 160000 ${oid} ${oid} vendor/lib`
    );
    const states = parseSubmoduleSubStates(stdout);
    expect([...states.keys()]).toEqual(["vendor/lib"]);
    expect(states.get("vendor/lib")?.commitChanged).toBe(true);
  });

  it("does not let a malformed rename record swallow the record behind it", () => {
    const stdout = framed("2 truncated", `1 .M S.M. 160000 160000 160000 ${oid} ${oid} vendor/lib`);
    expect([...parseSubmoduleSubStates(stdout).keys()]).toEqual(["vendor/lib"]);
  });

  it("reads a renamed submodule's own sub-state and skips its origin path", () => {
    const stdout = framed(
      `2 RM SCMU 160000 160000 160000 ${oid} ${oid} R100 vendor/lib two`,
      "vendor/lib",
      "? after.txt"
    );
    const states = parseSubmoduleSubStates(stdout);
    expect([...states.keys()]).toEqual(["vendor/lib two"]);
    expect(states.get("vendor/lib two")?.untrackedContent).toBe(true);
  });

  it("marks an unmerged gitlink conflicted and reads the sub-state past four modes", () => {
    const stdout = framed(`u UU S... 160000 160000 160000 160000 ${oid} ${oid} ${oid} vendor/lib`);
    const state = parseSubmoduleSubStates(stdout).get("vendor/lib");
    expect(state?.conflicted).toBe(true);
    expect(state?.commitChanged).toBe(false);
  });

  it("keeps paths that contain spaces intact", () => {
    const stdout = framed(`1 .M S.M. 160000 160000 160000 ${oid} ${oid} ven dor/li b`);
    expect([...parseSubmoduleSubStates(stdout).keys()]).toEqual(["ven dor/li b"]);
  });
});

describe("parseGitmodulesConfig", () => {
  it("groups properties under the stanza name", () => {
    const stdout = framed(
      "submodule.vendor/lib.path\nvendor/lib",
      "submodule.vendor/lib.url\n../sub",
      "submodule.vendor/lib.branch\nmain",
      "submodule.other.url\nhttps://example.test/other.git"
    );
    const stanzas = parseGitmodulesConfig(stdout);
    expect(stanzas.get("vendor/lib")).toEqual({
      path: "vendor/lib",
      url: "../sub",
      branch: "main",
    });
    expect(stanzas.get("other")?.url).toBe("https://example.test/other.git");
  });

  it("takes the property from the last dot so dotted names survive", () => {
    const stdout = framed("submodule.vendor/lib.js.path\nvendor/lib.js");
    const stanzas = parseGitmodulesConfig(stdout);
    expect([...stanzas.keys()]).toEqual(["vendor/lib.js"]);
    expect(stanzas.get("vendor/lib.js")?.path).toBe("vendor/lib.js");
  });

  it("treats a valueless key as an empty value rather than dropping the stanza", () => {
    const stdout = framed("submodule.x.shallow");
    expect(parseGitmodulesConfig(stdout).get("x")).toEqual({ shallow: "" });
  });

  it("ignores keys outside the submodule namespace and unknown properties", () => {
    const stdout = framed(
      "core.bare\nfalse",
      "submodule.x.active\ntrue",
      "submodule.x.url\n../sub"
    );
    expect(parseGitmodulesConfig(stdout).get("x")).toEqual({ url: "../sub" });
  });

  it("keeps a multi-line value whole", () => {
    const stdout = framed("submodule.x.url\nline one\nline two");
    expect(parseGitmodulesConfig(stdout).get("x")?.url).toBe("line one\nline two");
  });
});

// ---------------------------------------------------------------------------
// Fixture-backed tests. These need real git behaviour (pointer chains, module
// object stores, worktree-owned modules) that no amount of string fixtures can
// stand in for.
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" });
}

describe("buildSubmoduleDeleteRisk", () => {
  let tmp: string;
  let plain: string;
  let superRepo: string;
  let worktree: string;
  let bare: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "submodule-inventory-"));

    plain = path.join(tmp, "plain");
    mkdirSync(plain);
    git(plain, "init", "-q", "-b", "main", ".");
    writeFileSync(path.join(plain, "a.txt"), "a\n");
    git(plain, "add", ".");
    git(plain, "commit", "-qm", "init");

    const sub = path.join(tmp, "sub");
    mkdirSync(sub);
    git(sub, "init", "-q", "-b", "main", ".");
    writeFileSync(path.join(sub, "a.txt"), "one\n");
    git(sub, "add", ".");
    git(sub, "commit", "-qm", "sub init");

    superRepo = path.join(tmp, "super");
    mkdirSync(superRepo);
    git(superRepo, "init", "-q", "-b", "main", ".");
    writeFileSync(path.join(superRepo, "p.txt"), "p\n");
    git(superRepo, "add", ".");
    git(superRepo, "commit", "-qm", "parent init");
    // `file://`-style local remotes are refused by git >= 2.38 without this.
    git(
      superRepo,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      "../sub",
      "vendor/lib"
    );
    git(superRepo, "commit", "-qm", "add submodule");

    // A worktree whose submodule is never populated: `git worktree add` does
    // not initialize submodules, even with `submodule.recurse=true`.
    bare = path.join(tmp, "wt-uninit");
    git(superRepo, "worktree", "add", "-q", bare, "-b", "uninit");

    worktree = path.join(tmp, "wt1");
    git(superRepo, "worktree", "add", "-q", worktree, "-b", "wt1");
    git(worktree, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");

    // Work that deleting the worktree would destroy: an unpushed commit, a
    // dirty tracked file, and an untracked file — all inside the module.
    const checkout = path.join(worktree, "vendor", "lib");
    writeFileSync(path.join(checkout, "a.txt"), "committed locally\n");
    git(checkout, "commit", "-qam", "local unpushed commit");
    writeFileSync(path.join(checkout, "a.txt"), "and then dirtied\n");
    writeFileSync(path.join(checkout, "untracked.txt"), "u\n");
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("reports a clean, complete, force-free risk for a repo with no submodules", async () => {
    const risk = await buildSubmoduleDeleteRisk(plain);
    expect(risk.incomplete).toBe(false);
    expect(risk.requiresMechanicalForce).toBe(false);
    expect(risk.entries).toEqual([]);
    expect(risk.dirtyFiles).toEqual([]);
    expect(risk.untrackedFiles).toEqual([]);
    expect(risk.atRiskCommits).toEqual([]);
  });

  it("fails closed on a path that is not a repository", async () => {
    const risk = await buildSubmoduleDeleteRisk(path.join(tmp, "does-not-exist"));
    expect(risk.incomplete).toBe(true);
  });

  it("inventories a worktree's submodule work", async () => {
    const risk = await buildSubmoduleDeleteRisk(worktree);
    expect(risk.incomplete).toBe(false);
    expect(risk.entries.map((entry) => entry.path)).toEqual(["vendor/lib"]);

    const entry = risk.entries[0];
    expect(entry.name).toBe("vendor/lib");
    expect(entry.url).toBe("../sub");
    expect(entry.hasModifiedContent).toBe(true);
    expect(entry.hasUntrackedContent).toBe(true);
    // The submodule was committed onto locally, so HEAD has left the gitlink.
    expect(entry.state).toBe("moved");
    expect(entry.headOid).toBeTruthy();
    expect(entry.headOid).not.toBe(entry.recordedOid);
    expect(entry.recordedOid).toBe(
      git(worktree, "ls-files", "--stage", "vendor/lib").trim().split(/\s+/)[1]
    );
  });

  it("lists real nested paths prefixed with the submodule path", async () => {
    const risk = await buildSubmoduleDeleteRisk(worktree);
    expect(risk.dirtyFiles).toContain("vendor/lib/a.txt");
    expect(risk.untrackedFiles).toContain("vendor/lib/untracked.txt");
    // Nested paths must not be reported bare — a consumer joins them against
    // the worktree root.
    expect(risk.dirtyFiles.every((file) => file.startsWith("vendor/lib/"))).toBe(true);
  });

  it("surfaces the commit that exists only in the worktree's module store", async () => {
    const risk = await buildSubmoduleDeleteRisk(worktree);
    expect(risk.atRiskCommits.map((commit) => commit.subject)).toContain("local unpushed commit");
    const head = git(path.join(worktree, "vendor", "lib"), "rev-parse", "HEAD").trim();
    expect(risk.atRiskCommits.map((commit) => commit.oid)).toContain(head);
  });

  it("requires mechanical force exactly when the worktree owns a module directory", async () => {
    const worktreeGitDir = git(worktree, "rev-parse", "--absolute-git-dir").trim();
    expect(existsSync(path.join(worktreeGitDir, "modules"))).toBe(true);
    expect((await buildSubmoduleDeleteRisk(worktree)).requiresMechanicalForce).toBe(true);

    // The sibling worktree never populated its submodule, so it owns no module
    // directory and `git worktree remove` would not refuse on its account.
    const uninitGitDir = git(bare, "rev-parse", "--absolute-git-dir").trim();
    expect(existsSync(path.join(uninitGitDir, "modules"))).toBe(false);
    expect((await buildSubmoduleDeleteRisk(bare)).requiresMechanicalForce).toBe(false);
  });

  it("reports an unpopulated submodule without inventing content", async () => {
    const risk = await buildSubmoduleDeleteRisk(bare);
    expect(risk.incomplete).toBe(false);
    expect(risk.entries.map((entry) => entry.state)).toEqual(["uninitialized"]);
    expect(risk.entries[0].headOid).toBeUndefined();
    expect(risk.entries[0].recordedOid).toBeTruthy();
    expect(risk.dirtyFiles).toEqual([]);
    expect(risk.atRiskCommits).toEqual([]);
  });

  it("sets incomplete when the file list is truncated", async () => {
    const full = await buildSubmoduleDeleteRisk(worktree);
    expect(full.dirtyFiles.length + full.untrackedFiles.length).toBeGreaterThan(1);

    const capped = await buildSubmoduleDeleteRisk(worktree, { maxFilesTotal: 1 });
    expect(capped.incomplete).toBe(true);
    expect(capped.dirtyFiles.length + capped.untrackedFiles.length).toBe(1);

    // The per-module budget is shared between the two lists, so a dirty list
    // that fills it must not leave the untracked list looking clean by accident.
    const perModule = await buildSubmoduleDeleteRisk(worktree, { maxFilesPerModule: 1 });
    expect(perModule.incomplete).toBe(true);
    expect(perModule.dirtyFiles.length + perModule.untrackedFiles.length).toBe(1);
  });

  it("still finds an orphaned module after the submodule is committed away", async () => {
    const orphaned = path.join(tmp, "wt-orphan");
    git(superRepo, "worktree", "add", "-q", orphaned, "-b", "orphan");
    git(orphaned, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    const checkout = path.join(orphaned, "vendor", "lib");
    writeFileSync(path.join(checkout, "a.txt"), "orphan work\n");
    git(checkout, "commit", "-qam", "orphan unpushed commit");

    // Remove every roster source except the module store itself: index gitlink,
    // HEAD gitlink, and the `.gitmodules` stanza, all committed away.
    git(orphaned, "rm", "-q", "--cached", "vendor/lib");
    writeFileSync(path.join(orphaned, ".gitmodules"), "");
    git(orphaned, "add", ".gitmodules");
    git(orphaned, "commit", "-qm", "drop submodule from the tree");
    expect(git(orphaned, "ls-files", "--stage")).not.toContain("160000");
    expect(git(orphaned, "ls-tree", "-r", "HEAD")).not.toContain("160000");

    const risk = await buildSubmoduleDeleteRisk(orphaned);
    expect(risk.entries.map((entry) => entry.path)).toEqual(["vendor/lib"]);
    expect(risk.requiresMechanicalForce).toBe(true);
    expect(risk.atRiskCommits.map((commit) => commit.subject)).toContain("orphan unpushed commit");
  });

  it("finds a commit made on the submodule's detached HEAD", async () => {
    const detached = path.join(tmp, "wt-detached");
    git(superRepo, "worktree", "add", "-q", detached, "-b", "detached");
    git(detached, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    const checkout = path.join(detached, "vendor", "lib");
    const recorded = git(detached, "rev-parse", ":vendor/lib").trim();

    // Detached HEAD is a submodule's normal resting state, so an agent that
    // commits into one leaves the commit on no branch at all. Returning to the
    // recorded gitlink then makes the parent report nothing whatsoever.
    writeFileSync(path.join(checkout, "a.txt"), "committed while detached\n");
    git(checkout, "commit", "-qam", "detached-head commit");
    git(checkout, "checkout", "-q", "--detach", recorded);
    expect(git(checkout, "rev-list", "--branches", "--not", "--remotes").trim()).toBe("");
    expect(git(detached, "status", "--porcelain").trim()).toBe("");

    const risk = await buildSubmoduleDeleteRisk(detached);
    expect(risk.entries[0].state).toBe("at-recorded-commit");
    expect(risk.dirtyFiles).toEqual([]);
    // ...and yet deleting the worktree destroys the commit outright.
    expect(risk.atRiskCommits.map((commit) => commit.subject)).toContain("detached-head commit");
  });

  it("binds a custom-named module to its checkout path rather than its directory name", async () => {
    const named = path.join(tmp, "named-super");
    mkdirSync(named);
    git(named, "init", "-q", "-b", "main", ".");
    writeFileSync(path.join(named, "p.txt"), "p\n");
    git(named, "add", ".");
    git(named, "commit", "-qm", "init");
    git(
      named,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      "--name",
      "logical-name",
      path.join(tmp, "sub"),
      "vendor/lib"
    );
    git(named, "commit", "-qm", "add named submodule");
    // `--name` decouples the module directory from the checkout path.
    expect(existsSync(path.join(named, ".git", "modules", "logical-name"))).toBe(true);

    const risk = await buildSubmoduleDeleteRisk(named);
    // One entry at the checkout path — not a second, phantom one at the
    // logical name.
    expect(risk.entries.map((entry) => entry.path)).toEqual(["vendor/lib"]);
    expect(risk.entries[0].name).toBe("logical-name");

    // With the stanza committed away, only the module's own core.worktree can
    // still bind the logical name back to a checkout path.
    git(named, "rm", "-q", "--cached", "vendor/lib");
    writeFileSync(path.join(named, ".gitmodules"), "");
    git(named, "add", ".gitmodules");
    git(named, "commit", "-qm", "drop stanza");
    const orphanRisk = await buildSubmoduleDeleteRisk(named);
    expect(orphanRisk.entries.map((entry) => entry.path)).toEqual(["vendor/lib"]);
  });

  it("ignores a .gitmodules stanza that points outside the worktree", async () => {
    const escaping = path.join(tmp, "wt-escaping");
    git(superRepo, "worktree", "add", "-q", escaping, "-b", "escaping");
    writeFileSync(
      path.join(escaping, ".gitmodules"),
      '[submodule "self"]\n\tpath = .\n[submodule "outside"]\n\tpath = ../../elsewhere\n'
    );
    const risk = await buildSubmoduleDeleteRisk(escaping);
    // `vendor/lib` still comes from the index; the two bogus stanzas must not
    // turn the superproject (or an unrelated directory) into a submodule entry.
    expect(risk.entries.map((entry) => entry.path)).toEqual(["vendor/lib"]);
  });

  it("is not blinded by submodule.<name>.ignore = all", async () => {
    const ignored = path.join(tmp, "wt-ignored");
    git(superRepo, "worktree", "add", "-q", ignored, "-b", "ignored");
    git(ignored, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    git(ignored, "config", "-f", ".gitmodules", "submodule.vendor/lib.ignore", "all");
    const checkout = path.join(ignored, "vendor", "lib");
    writeFileSync(path.join(checkout, "a.txt"), "hidden by config\n");
    writeFileSync(path.join(checkout, "hidden.txt"), "u\n");

    const risk = await buildSubmoduleDeleteRisk(ignored);
    expect(risk.entries[0].hasModifiedContent).toBe(true);
    expect(risk.dirtyFiles).toContain("vendor/lib/a.txt");
    expect(risk.untrackedFiles).toContain("vendor/lib/hidden.txt");
  });
});

describe("resolveModuleGitDir", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "module-gitdir-"));
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when the submodule is not checked out", async () => {
    mkdirSync(path.join(tmp, "empty", "vendor", "lib"), { recursive: true });
    expect(await resolveModuleGitDir(path.join(tmp, "empty"), "vendor/lib")).toBeNull();
  });

  it("returns the directory for an old-form embedded .git", async () => {
    const root = path.join(tmp, "embedded");
    const gitDir = path.join(root, "vendor", "lib", ".git");
    mkdirSync(gitDir, { recursive: true });
    expect(await resolveModuleGitDir(root, "vendor/lib")).toBe(gitDir);
  });

  it("follows a relative gitdir pointer against the checkout, not the worktree root", async () => {
    const root = path.join(tmp, "relative");
    const target = path.join(root, ".git", "modules", "vendor", "lib");
    mkdirSync(target, { recursive: true });
    mkdirSync(path.join(root, "vendor", "lib"), { recursive: true });
    writeFileSync(
      path.join(root, "vendor", "lib", ".git"),
      "gitdir: ../../.git/modules/vendor/lib\n"
    );
    expect(await resolveModuleGitDir(root, "vendor/lib")).toBe(target);
  });

  it("follows an absolute gitdir pointer", async () => {
    const root = path.join(tmp, "absolute");
    const target = path.join(tmp, "elsewhere", "module");
    mkdirSync(target, { recursive: true });
    mkdirSync(path.join(root, "vendor", "lib"), { recursive: true });
    writeFileSync(path.join(root, "vendor", "lib", ".git"), `gitdir: ${target}\n`);
    expect(await resolveModuleGitDir(root, "vendor/lib")).toBe(target);
  });

  it("returns null for a pointer that leads nowhere", async () => {
    const root = path.join(tmp, "dangling");
    mkdirSync(path.join(root, "vendor", "lib"), { recursive: true });
    writeFileSync(path.join(root, "vendor", "lib", ".git"), "gitdir: ../../.git/modules/gone\n");
    expect(await resolveModuleGitDir(root, "vendor/lib")).toBeNull();
  });

  it("returns null for a .git file that is not a pointer", async () => {
    const root = path.join(tmp, "garbage");
    mkdirSync(path.join(root, "vendor", "lib"), { recursive: true });
    writeFileSync(path.join(root, "vendor", "lib", ".git"), "not a pointer\n");
    expect(await resolveModuleGitDir(root, "vendor/lib")).toBeNull();
  });
});
