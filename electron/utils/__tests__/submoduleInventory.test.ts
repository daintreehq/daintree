import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MalformedGitOutputError,
  buildSubmoduleDeleteRisk,
  parseGitmodulesConfig,
  parseIndexGitlinks,
  parseSubmoduleSubStates,
  parseTreeGitlinks,
  resolveModuleGitDir,
  toRosterPath,
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

  it("rejects the whole listing rather than emitting a short roster", () => {
    // Skipping a record it cannot read would hand the caller a roster that is
    // silently missing a submodule, which is indistinguishable from a
    // repository that has fewer. The roster is the authority for everything
    // downstream, so an unreadable record has to reject the listing outright.
    const good = "160000 f1d8402c6bb2266e199a4d99159900189160ddea 0\tvendor/ok";
    for (const bad of [
      "160000 f1d8402c6bb2266e199a4d99159900189160ddea 0",
      "160000 f1d8402c6bb2266e199a4d99159900189160ddea 9\tvendor/bad-stage",
      "160000 f1d8402c6bb2266e199a4d99159900189160ddea 0\t",
      "160000 not-an-oid 0\tvendor/bad-oid",
      "16000 f1d8402c6bb2266e199a4d99159900189160ddea 0\tvendor/bad-mode",
    ]) {
      expect(() => parseIndexGitlinks(framed(bad, good))).toThrow(MalformedGitOutputError);
    }
  });

  it("rejects output that was cut short mid-record", () => {
    const whole = framed("160000 f1d8402c6bb2266e199a4d99159900189160ddea 0\tvendor/ok");
    expect(parseIndexGitlinks(whole)).toHaveLength(1);
    expect(() => parseIndexGitlinks(whole.slice(0, -1))).toThrow(MalformedGitOutputError);
    expect(() => parseIndexGitlinks(`${whole}\0`)).toThrow(MalformedGitOutputError);
  });

  it("treats empty output as an empty listing, not a failure", () => {
    expect(parseIndexGitlinks("")).toEqual([]);
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

  it("rejects a malformed rename record instead of parsing on past it", () => {
    // A `2` record's framing makes position state: its origin path is a second
    // NUL token. Once one record is unreadable, every record's identity after
    // it is a guess — and a guessed-short list of at-risk files reads exactly
    // like a clean one, so the whole output has to be rejected.
    const stdout = framed("2 truncated", `1 .M S.M. 160000 160000 160000 ${oid} ${oid} vendor/lib`);
    expect(() => parseSubmoduleSubStates(stdout)).toThrow(MalformedGitOutputError);
  });

  it("rejects a rename record whose origin path never arrives", () => {
    // The `2` header parses cleanly and sits at the buffer edge: the origin
    // token it promises is simply not there, which means the output was cut.
    const stdout = framed(`2 R. N... 100644 100644 100644 ${oid} ${oid} R100 renamed`);
    expect(() => parseSubmoduleSubStates(stdout)).toThrow(/origin path/);

    // ...and with the origin present it parses, so the rejection above is
    // about the missing token and not about the header.
    const whole = framed(`2 R. N... 100644 100644 100644 ${oid} ${oid} R100 renamed`, "p.txt");
    expect(parseSubmoduleSubStates(whole).size).toBe(0);
  });

  it("rejects output that does not end in NUL", () => {
    const whole = framed(`1 .M S.M. 160000 160000 160000 ${oid} ${oid} vendor/lib`);
    expect(parseSubmoduleSubStates(whole).size).toBe(1);
    expect(() => parseSubmoduleSubStates(whole.slice(0, -1))).toThrow(MalformedGitOutputError);
  });

  it("rejects a record kind and a sub-state field it does not recognise", () => {
    expect(() => parseSubmoduleSubStates(framed("x junk record"))).toThrow(/unknown record kind/);
    expect(() =>
      parseSubmoduleSubStates(framed(`1 .M SXYZ 160000 160000 160000 ${oid} ${oid} vendor/lib`))
    ).toThrow(/sub-state/);
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

  it("rejects slipped framing rather than returning a short stanza map", () => {
    const whole = framed("submodule.x.url\n../sub");
    expect(parseGitmodulesConfig(whole).size).toBe(1);
    expect(() => parseGitmodulesConfig(whole.slice(0, -1))).toThrow(MalformedGitOutputError);
    // Every key git emits is at least `<section>.<name>`.
    expect(() => parseGitmodulesConfig(framed("bareword\nvalue"))).toThrow(/unreadable key/);
  });
});

describe("toRosterPath", () => {
  it("keeps a relative path inside the worktree", () => {
    expect(toRosterPath("vendor/lib")).toBe("vendor/lib");
    expect(toRosterPath("vendor/lib/")).toBe("vendor/lib");
    expect(toRosterPath("./vendor//lib")).toBe("vendor/lib");
  });

  it("rejects traversal under BOTH separator vocabularies", () => {
    // `path.win32.resolve("C:\\repo\\wt", "..\\..\\outside")` escapes to
    // `C:\outside`, so a backslash-separated traversal has to be rejected even
    // though the returned path still splits on `/` alone.
    for (const escape of [
      "..",
      "../../outside",
      "vendor/../../outside",
      "..\\..\\outside",
      "vendor\\..\\..\\outside",
    ]) {
      expect(toRosterPath(escape)).toBeNull();
    }
    // A backslash that is not traversal stays a legal POSIX filename.
    expect(toRosterPath("ven\\dor")).toBe("ven\\dor");
  });

  it("rejects absolute, drive-relative and UNC paths", () => {
    for (const absolute of ["/etc", "C:\\Windows", "c:relative", "\\\\server\\share", "\\rooted"]) {
      expect(toRosterPath(absolute)).toBeNull();
    }
  });

  it("rejects the worktree root itself and empty values", () => {
    for (const value of [".", "./", "", undefined, "a\0b"]) {
      expect(toRosterPath(value)).toBeNull();
    }
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

  it("enumerates a nonempty checkout that carries no git metadata", async () => {
    const stray = path.join(tmp, "wt-stray");
    git(superRepo, "worktree", "add", "-q", stray, "-b", "stray");
    const checkout = path.join(stray, "vendor", "lib");
    mkdirSync(path.join(checkout, "src"), { recursive: true });
    writeFileSync(path.join(checkout, "src", "main.c"), "int main(){}\n");

    // The parent cannot rescue this: an uninitialized submodule is invisible to
    // `git status`, so if the inventory skips file inspection here there is no
    // second source that would report the content.
    expect(git(stray, "status", "--porcelain", "--ignore-submodules=none").trim()).toBe("");

    const risk = await buildSubmoduleDeleteRisk(stray);
    expect(risk.entries.map((entry) => entry.state)).toEqual(["uninitialized"]);
    expect(risk.untrackedFiles).toContain("vendor/lib/src/main.c");
    expect(risk.entries[0].hasUntrackedContent).toBe(true);
  });

  it("fails closed on a dangling gitdir pointer rather than reporting an empty risk", async () => {
    const broken = path.join(tmp, "wt-broken");
    git(superRepo, "worktree", "add", "-q", broken, "-b", "broken");
    const checkout = path.join(broken, "vendor", "lib");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(path.join(checkout, "work.txt"), "unsaved\n");
    writeFileSync(path.join(checkout, ".git"), "gitdir: ../../.git/modules/gone\n");

    const risk = await buildSubmoduleDeleteRisk(broken);
    expect(risk.incomplete).toBe(true);
    expect(risk.untrackedFiles).toContain("vendor/lib/work.txt");
  });

  // A named pipe where `.git` belongs is the one broken shape the parent's own
  // `git status` tolerates in silence, which makes it the only fixture where
  // "metadata we could not read" has to carry `incomplete` on its own. mkfifo
  // has no Windows equivalent; CI is Ubuntu.
  it.skipIf(process.platform === "win32")(
    "does not read unreadable metadata as an uninitialized submodule",
    async () => {
      const special = path.join(tmp, "wt-special");
      git(superRepo, "worktree", "add", "-q", special, "-b", "special");
      const checkout = path.join(special, "vendor", "lib");
      mkdirSync(checkout, { recursive: true });
      writeFileSync(path.join(checkout, "work.txt"), "unsaved\n");
      execFileSync("mkfifo", [path.join(checkout, ".git")]);

      // git says nothing at all about this submodule, so a silent
      // `uninitialized` here is the last word anyone gets.
      expect(git(special, "status", "--porcelain", "--ignore-submodules=none").trim()).toBe("");

      const risk = await buildSubmoduleDeleteRisk(special);
      expect(risk.incomplete).toBe(true);
      expect(risk.untrackedFiles).toContain("vendor/lib/work.txt");
    }
  );

  it("does not let a .gitmodules stanza alone put a path on the roster", async () => {
    const stanzaOnly = path.join(tmp, "wt-stanza");
    git(superRepo, "worktree", "add", "-q", stanzaOnly, "-b", "stanza-only");
    const probe = path.join(stanzaOnly, "probe");
    mkdirSync(probe);
    writeFileSync(path.join(probe, "notes.txt"), "not a submodule\n");
    writeFileSync(
      path.join(stanzaOnly, ".gitmodules"),
      '[submodule "probe"]\n\tpath = probe\n\turl = ../sub\n'
    );

    // `.gitmodules` is tracked, attacker-influenceable content. The index never
    // called `probe` a submodule, so nothing under it is stat'ed or read.
    const risk = await buildSubmoduleDeleteRisk(stanzaOnly);
    expect(risk.entries.map((entry) => entry.path)).toEqual(["vendor/lib"]);
    expect(risk.untrackedFiles.some((file) => file.startsWith("probe/"))).toBe(false);
    expect(risk.dirtyFiles.some((file) => file.startsWith("probe/"))).toBe(false);
  });

  it("refuses to inspect a checkout that resolves outside the worktree", async () => {
    const linked = path.join(tmp, "wt-symlink");
    git(superRepo, "worktree", "add", "-q", linked, "-b", "symlink");

    const outside = path.join(tmp, "outside-repo");
    mkdirSync(outside);
    git(outside, "init", "-q", "-b", "main", ".");
    writeFileSync(path.join(outside, "private.txt"), "private\n");
    git(outside, "add", ".");
    git(outside, "commit", "-qm", "private work nobody asked about");
    writeFileSync(path.join(outside, "private.txt"), "dirtied\n");

    rmSync(path.join(linked, "vendor", "lib"), { recursive: true, force: true });
    symlinkSync(outside, path.join(linked, "vendor", "lib"), "dir");

    // Lexical containment says `vendor/lib` is inside; the symlink says
    // otherwise, and reporting an unrelated repository's commit subjects as
    // this worktree's at-risk work is both wrong and a disclosure.
    const risk = await buildSubmoduleDeleteRisk(linked);
    expect(risk.incomplete).toBe(true);
    expect(risk.dirtyFiles).toEqual([]);
    expect(risk.atRiskCommits.map((commit) => commit.subject)).not.toContain(
      "private work nobody asked about"
    );
  });

  it("inventories every store that claims one checkout, not just the first", async () => {
    const collide = path.join(tmp, "wt-collision");
    git(superRepo, "worktree", "add", "-q", collide, "-b", "collision");
    git(collide, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    expect((await buildSubmoduleDeleteRisk(collide)).incomplete).toBe(false);

    const decoyWork = path.join(tmp, "decoy-work");
    mkdirSync(decoyWork);
    git(decoyWork, "init", "-q", "-b", "main", ".");
    writeFileSync(path.join(decoyWork, "d.txt"), "d\n");
    git(decoyWork, "add", ".");
    git(decoyWork, "commit", "-qm", "decoy store commit");

    // A second worktree-owned store bound to the SAME checkout path.
    // `worktree remove` deletes both, so keying the inventory on the checkout
    // path alone silently drops one of them and its commits with it.
    const gitDir = git(collide, "rev-parse", "--absolute-git-dir").trim();
    const decoyGitDir = path.join(gitDir, "modules", "decoy");
    cpSync(path.join(decoyWork, ".git"), decoyGitDir, { recursive: true });
    git(
      tmp,
      "config",
      "-f",
      path.join(decoyGitDir, "config"),
      "core.worktree",
      path.join(collide, "vendor", "lib")
    );

    const risk = await buildSubmoduleDeleteRisk(collide);
    expect(risk.incomplete).toBe(true);
    expect(risk.atRiskCommits.map((commit) => commit.subject)).toContain("decoy store commit");
  });

  it("does not fall back to the conventional name when the binding read fails", async () => {
    const opaque = path.join(tmp, "opaque-super");
    mkdirSync(opaque);
    git(opaque, "init", "-q", "-b", "main", ".");
    writeFileSync(path.join(opaque, "p.txt"), "p\n");
    git(opaque, "add", ".");
    git(opaque, "commit", "-qm", "init");
    git(
      opaque,
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
    git(opaque, "commit", "-qm", "add named submodule");
    git(opaque, "rm", "-q", "--cached", "vendor/lib");
    writeFileSync(path.join(opaque, ".gitmodules"), "");
    git(opaque, "add", ".gitmodules");
    git(opaque, "commit", "-qm", "drop stanza");
    writeFileSync(path.join(opaque, "vendor", "lib", "a.txt"), "work that would be lost\n");

    // A config file that cannot be read at all — the shape a transient failure
    // takes. `logical-name` is a module DIRECTORY name, never a repo path, so
    // binding to it strands the real checkout at vendor/lib uninspected while
    // the HEAD and reflog probes go on succeeding against the store.
    const storeConfig = path.join(opaque, ".git", "modules", "logical-name", "config");
    rmSync(storeConfig);
    mkdirSync(storeConfig);

    const risk = await buildSubmoduleDeleteRisk(opaque);
    expect(risk.incomplete).toBe(true);
    expect(risk.entries.map((entry) => entry.path)).not.toContain("logical-name");
  });

  /**
   * A superproject whose only surviving evidence of its submodule is the module
   * store itself: custom `--name`, gitlink dropped from the index and HEAD.
   * Everything about which checkout it belongs to then rests on the binding.
   */
  function buildOrphanedStoreRepo(name: string): { root: string; storeConfig: string } {
    const root = path.join(tmp, name);
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main", ".");
    writeFileSync(path.join(root, "p.txt"), "p\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    git(
      root,
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
    git(root, "commit", "-qm", "add named submodule");
    git(root, "rm", "-q", "--cached", "vendor/lib");
    writeFileSync(path.join(root, ".gitmodules"), "");
    git(root, "add", ".gitmodules");
    git(root, "commit", "-qm", "drop stanza");
    return { root, storeConfig: path.join(root, ".git", "modules", "logical-name", "config") };
  }

  it("binds a store by its own core.worktree, not by a stale stanza", async () => {
    const { root } = buildOrphanedStoreRepo("stale-super");
    writeFileSync(path.join(root, "vendor", "lib", "a.txt"), "work at risk\n");
    // A stanza is a claim ABOUT the store; core.worktree is the store's own.
    // Letting the stanza win rebuilds the fail-open the roster change closed —
    // `.gitmodules` deciding which path gets inspected.
    writeFileSync(
      path.join(root, ".gitmodules"),
      '[submodule "logical-name"]\n\tpath = probe\n\turl = ../sub\n'
    );

    const risk = await buildSubmoduleDeleteRisk(root);
    expect(risk.entries.map((entry) => entry.path)).toEqual(["vendor/lib"]);
    expect(risk.dirtyFiles).toContain("vendor/lib/a.txt");
    // The store and `.gitmodules` name different checkouts: a disagreement the
    // gate cannot adjudicate, so it fails closed on top of binding correctly.
    expect(risk.incomplete).toBe(true);
  });

  it("resolves a repeated core.worktree the way git does", async () => {
    const { root, storeConfig } = buildOrphanedStoreRepo("repeated-super");
    writeFileSync(path.join(root, "vendor", "lib", "a.txt"), "work at risk\n");
    git(tmp, "config", "-f", storeConfig, "--unset-all", "core.worktree");
    git(tmp, "config", "-f", storeConfig, "--add", "core.worktree", path.join(root, "decoy"));
    git(
      tmp,
      "config",
      "-f",
      storeConfig,
      "--add",
      "core.worktree",
      path.join(root, "vendor", "lib")
    );
    // git resolves a single-valued key to its LAST occurrence.
    expect(git(tmp, "config", "-f", storeConfig, "--get", "core.worktree").trim()).toBe(
      path.join(root, "vendor", "lib")
    );

    const risk = await buildSubmoduleDeleteRisk(root);
    expect(risk.entries.map((entry) => entry.path)).toEqual(["vendor/lib"]);
    expect(risk.dirtyFiles).toContain("vendor/lib/a.txt");
  });

  it("fails closed when a gitlink path is a regular file", async () => {
    const typechanged = path.join(tmp, "wt-typechange");
    git(superRepo, "worktree", "add", "-q", typechanged, "-b", "typechange");
    rmSync(path.join(typechanged, "vendor", "lib"), { recursive: true, force: true });
    writeFileSync(path.join(typechanged, "vendor", "lib"), "unsaved work\n");

    // `<file>/.git` answers ENOTDIR, which reads as "no metadata", and the file
    // itself is not a directory to enumerate — so both inventory branches skip
    // it and the content would be discarded unannounced.
    const risk = await buildSubmoduleDeleteRisk(typechanged);
    expect(risk.incomplete).toBe(true);
  });

  it("does not lose an orphaned store that has no HEAD", async () => {
    const ghosted = path.join(tmp, "wt-ghost");
    git(superRepo, "worktree", "add", "-q", ghosted, "-b", "ghost");
    git(ghosted, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    expect((await buildSubmoduleDeleteRisk(ghosted)).incomplete).toBe(false);

    // A repository skeleton with objects and a config but no HEAD. Identifying
    // stores by HEAD alone descended into this as a namespace directory, found
    // nothing, and returned a clean inventory — while `worktree remove`
    // destroys its objects exactly like a healthy store's.
    const gitDir = git(ghosted, "rev-parse", "--absolute-git-dir").trim();
    const ghost = path.join(gitDir, "modules", "ghost");
    mkdirSync(path.join(ghost, "objects", "pack"), { recursive: true });
    mkdirSync(path.join(ghost, "refs", "heads"), { recursive: true });
    writeFileSync(
      path.join(ghost, "config"),
      `[core]\n\tworktree = ${path.join(ghosted, "vendor", "ghost")}\n`
    );

    expect((await buildSubmoduleDeleteRisk(ghosted)).incomplete).toBe(true);
  });

  it("fails closed on a store that holds nested submodule stores", async () => {
    const nested = path.join(tmp, "wt-nested");
    git(superRepo, "worktree", "add", "-q", nested, "-b", "nested");
    git(nested, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    expect((await buildSubmoduleDeleteRisk(nested)).incomplete).toBe(false);

    // The scan stops descending once it recognises a repository, so a nested
    // submodule's own store is never walked — while `worktree remove --force`
    // deletes it along with everything else under the worktree's gitdir. The
    // presence of `modules/` is the only signal available at depth 1.
    const gitDir = git(nested, "rev-parse", "--absolute-git-dir").trim();
    mkdirSync(path.join(gitDir, "modules", "vendor", "lib", "modules", "child", "objects"), {
      recursive: true,
    });

    expect((await buildSubmoduleDeleteRisk(nested)).incomplete).toBe(true);
  });

  it("fails closed when an inferred checkout path turns out to be absent", async () => {
    const moved = path.join(tmp, "wt-moved");
    git(superRepo, "worktree", "add", "-q", moved, "-b", "moved");
    git(moved, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");

    // A store that declares no `core.worktree` of its own can only be bound by
    // a second-hand claim. When that guess names a path with nothing on it, the
    // real checkout may simply have been moved elsewhere in the worktree, still
    // pointing at this store and still holding uncommitted work that would
    // never be read.
    const gitDir = git(moved, "rev-parse", "--absolute-git-dir").trim();
    const store = path.join(gitDir, "modules", "vendor", "lib");
    writeFileSync(path.join(store, "config"), "[core]\n\tbare = false\n");
    rmSync(path.join(moved, "vendor", "lib"), { recursive: true, force: true });

    expect((await buildSubmoduleDeleteRisk(moved)).incomplete).toBe(true);
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
