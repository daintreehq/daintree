import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startOnlineOnlyProbe,
  startOnlineOnlyScan,
  type OnlineOnlyScanSide,
} from "../onlineOnlyScan.js";

// Nothing outside a File Provider can set dataless (`chflags dataless` exits 0
// and sets nothing), so these drive the real find with a flag an owner can set.
const FLAG = "nodump";
const budgetMs = 10_000;

const flag = (...paths: string[]) => execFileSync("/usr/bin/chflags", [FLAG, ...paths]);
const unflag = (...paths: string[]) => execFileSync("/usr/bin/chflags", ["dump", ...paths]);
const flagsOf = (path: string) =>
  execFileSync("/usr/bin/stat", ["-f", "%Xf", path], { encoding: "utf8" }).trim();

describe.runIf(process.platform === "darwin")("online-only scan with the real find", () => {
  let base: string;
  let root: string;

  const scan = (side: OnlineOnlyScanSide, at = root) =>
    startOnlineOnlyScan(at, side, { budgetMs, flag: FLAG }).result;
  const probe = (at = root) => startOnlineOnlyProbe(at, { budgetMs, flag: FLAG }).result;

  async function file(relative: string): Promise<string> {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "content");
    return path;
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "online-only-scan-"));
    // The characters a project path really has, and that find's patterns would trip on.
    root = join(base, "Video Editor [1] (*)");
    await mkdir(root);
  });

  afterEach(async () => {
    execFileSync("/bin/chmod", ["-R", "u+rwx", base]);
    execFileSync("/usr/bin/chflags", ["-R", "dump", base]);
    await rm(base, { recursive: true, force: true });
  });

  it("finds nothing in a tree with no placeholders", async () => {
    await file(".git/HEAD");
    await file("src/index.ts");

    expect(await probe()).toBe("git-directory");
    expect(await scan("git")).toEqual({ files: 0, directories: 0, complete: true });
    expect(await scan("workingTree")).toEqual({ files: 0, directories: 0, complete: true });
  });

  it("is accepted by this macOS with the flag production uses", async () => {
    await file("src/index.ts");

    const seen = await startOnlineOnlyScan(root, "workingTree", { budgetMs }).result;

    expect(seen.complete).toBe(true);
  });

  it("splits what it finds between .git and the working tree", async () => {
    flag(
      await file(".git/COMMIT_EDITMSG"),
      await file(".git/objects/aa/one"),
      await file(".git/objects/aa/two"),
      await file("CLAUDE.md"),
      await file("src/deep/down/file.ts")
    );
    await file(".git/HEAD");
    await file("src/plain.ts");

    expect(await scan("git")).toEqual({ files: 3, directories: 0, complete: true });
    expect(await scan("workingTree")).toEqual({ files: 2, directories: 0, complete: true });
  });

  it("counts a flagged directory once and never looks inside it", async () => {
    const inner = await file("assets/inner/video.mov");
    flag(inner, join(root, "assets"));

    expect(await scan("workingTree")).toEqual({ files: 0, directories: 1, complete: true });
  });

  it("follows the count down to zero as files arrive", async () => {
    const first = await file(".git/ORIG_HEAD");
    const second = await file("src/a.ts");
    const third = await file("src/b.ts");
    flag(first, second, third);
    expect((await scan("git")).files).toBe(1);
    expect((await scan("workingTree")).files).toBe(2);

    unflag(second);
    expect((await scan("workingTree")).files).toBe(1);

    unflag(first, third);
    expect(await scan("git")).toEqual({ files: 0, directories: 0, complete: true });
    expect(await scan("workingTree")).toEqual({ files: 0, directories: 0, complete: true });
  });

  it("never opens a flagged file", async () => {
    // A FIFO blocks whoever opens it with no writer, as a placeholder blocks a
    // read, and a mode-000 file fails. Finishing clean means neither was opened.
    const fifo = join(root, "pipe");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const locked = await file("locked.bin");
    await chmod(locked, 0o000);
    flag(fifo, locked);
    const before = [flagsOf(fifo), flagsOf(locked)];

    expect(await scan("workingTree")).toEqual({ files: 2, directories: 0, complete: true });
    expect([flagsOf(fifo), flagsOf(locked)]).toEqual(before);
  });

  it("answers a flagged root once, from the working tree, without entering it", async () => {
    flag(await file(".git/HEAD"), await file("src/a.ts"));
    flag(root);

    expect(await probe()).toBe("root-online-only");
    expect(await scan("workingTree")).toEqual({ files: 0, directories: 1, complete: true });
  });

  it("tells a .git directory, a pointer file and no .git apart", async () => {
    expect(await probe()).toBe("no-git");

    const pointer = await file(".git");
    expect(await probe()).toBe("git-pointer");

    await rm(pointer);
    await file(".git/HEAD");
    flag(join(root, ".git"));
    expect(await probe()).toBe("git-directory");
    expect(await scan("git")).toEqual({ files: 0, directories: 1, complete: true });
  });

  it("counts a flagged pointer file as one file", async () => {
    flag(await file(".git"));

    expect(await probe()).toBe("git-pointer");
    expect(await scan("git")).toEqual({ files: 1, directories: 0, complete: true });
  });

  it("walks a symlinked root instead of reporting it empty", async () => {
    flag(await file("src/a.ts"));
    const link = join(base, "link");
    await symlink(root, link);

    expect(await scan("workingTree", link)).toEqual({ files: 1, directories: 0, complete: true });
  });

  it("never turns a missing root into a zero", async () => {
    const gone = join(base, "gone");

    expect(await probe(gone)).toBe("unknown");
    expect((await scan("workingTree", gone)).complete).toBe(false);
  });

  it("never turns a flag this find rejects into a zero", async () => {
    await file("src/a.ts");
    const options = { budgetMs, flag: "notaflag" };

    expect(await startOnlineOnlyProbe(root, options).result).toBe("unknown");
    expect((await startOnlineOnlyScan(root, "workingTree", options).result).complete).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps what it saw when a folder can't be read, but doesn't claim to have seen it all",
    async () => {
      flag(await file("visible.ts"));
      await file("locked/hidden.ts");
      await chmod(join(root, "locked"), 0o000);

      expect(await scan("workingTree")).toEqual({ files: 1, directories: 0, complete: false });
    }
  );

  it("exits when cancelled", async () => {
    await file("src/a.ts");
    const pass = startOnlineOnlyScan(root, "workingTree", { budgetMs, flag: FLAG });

    pass.cancel();

    expect((await pass.result).complete).toBe(false);
    await pass.exited;
  });
});
