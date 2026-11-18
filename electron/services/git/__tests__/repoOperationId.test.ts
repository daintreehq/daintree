import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCurrentRepoOperationId, readRepoOperationId } from "../repoOperationState.js";

let gitDir: string;

beforeEach(() => {
  gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-operation-id-"));
});

afterEach(() => {
  fs.rmSync(gitDir, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  const file = path.join(gitDir, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Replace a file the way a restarted operation does: a new file in its place. */
async function recreate(relative: string, content: string): Promise<void> {
  fs.rmSync(path.join(gitDir, ...relative.split("/")));
  // Past the coarse clock some filesystems stamp from, so the new file's
  // modification time can differ even where its inode is reused.
  await new Promise((resolve) => setTimeout(resolve, 25));
  write(relative, content);
}

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

describe("readRepoOperationId (#17559)", () => {
  it("is stable across reads of one merge and changes when the same merge starts again", async () => {
    write("MERGE_HEAD", `${OID_A}\n`);
    const first = await readRepoOperationId(gitDir, "MERGING");
    expect(first).toEqual(expect.any(String));
    expect(await readRepoOperationId(gitDir, "MERGING")).toBe(first);

    await recreate("MERGE_HEAD", `${OID_A}\n`);
    const restarted = await readRepoOperationId(gitDir, "MERGING");
    expect(restarted).toEqual(expect.any(String));
    expect(restarted).not.toBe(first);
  });

  it("can't identify an anchor replaced while its open handle was being read", async () => {
    write("MERGE_HEAD", `${OID_A}\n`);
    const realOpen = fs.promises.open;
    const opened = vi.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      // Another client replaces the merge after the handle has the old file.
      fs.rmSync(path.join(gitDir, "MERGE_HEAD"));
      write("MERGE_HEAD", `${OID_A}\n`);
      return handle;
    });
    try {
      expect(await readRepoOperationId(gitDir, "MERGING")).toBeNull();
    } finally {
      opened.mockRestore();
    }
    expect(await readRepoOperationId(gitDir, "MERGING")).toEqual(expect.any(String));
  });

  it("keeps a rebase's identity while its steps advance, for either backend, and not past a restart", async () => {
    for (const backend of ["rebase-merge", "rebase-apply"]) {
      fs.rmSync(gitDir, { recursive: true, force: true });
      fs.mkdirSync(gitDir);
      write(`${backend}/orig-head`, `${OID_A}\n`);
      write(`${backend}/msgnum`, "1\n");
      const first = await readRepoOperationId(gitDir, "REBASING");
      expect(first).toEqual(expect.any(String));

      write(`${backend}/msgnum`, "2\n");
      write(`${backend}/done`, `pick ${OID_B}\n`);
      expect(await readRepoOperationId(gitDir, "REBASING")).toBe(first);

      await recreate(`${backend}/orig-head`, `${OID_A}\n`);
      const restarted = await readRepoOperationId(gitDir, "REBASING");
      expect(restarted).toEqual(expect.any(String));
      expect(restarted).not.toBe(first);
    }
  });

  it("follows a `git am` session by its applying marker, which writes no orig-head", async () => {
    write("rebase-apply/applying", "");
    write("rebase-apply/next", "1\n");
    // Read as a rebase it has no anchor: only the mailbox state can name it.
    expect(await readRepoOperationId(gitDir, "REBASING")).toBeNull();
    const first = await readRepoOperationId(gitDir, "APPLYING_MAILBOX");
    expect(first).toEqual(expect.any(String));

    // Each patch it stops on moves `next`, not the session.
    write("rebase-apply/next", "2\n");
    expect(await readRepoOperationId(gitDir, "APPLYING_MAILBOX")).toBe(first);

    // The same series applied again: only the new marker's identity differs.
    await recreate("rebase-apply/applying", "");
    const restarted = await readRepoOperationId(gitDir, "APPLYING_MAILBOX");
    expect(restarted).toEqual(expect.any(String));
    expect(restarted).not.toBe(first);
  });

  it("follows a multi-commit cherry-pick by its sequencer, not the commit it stopped on", async () => {
    write("sequencer/head", `${OID_A}\n`);
    write("CHERRY_PICK_HEAD", `${OID_A}\n`);
    const first = await readRepoOperationId(gitDir, "CHERRY_PICKING");
    expect(first).toEqual(expect.any(String));

    await recreate("CHERRY_PICK_HEAD", `${OID_B}\n`);
    expect(await readRepoOperationId(gitDir, "CHERRY_PICKING")).toBe(first);
  });

  it("follows a single-commit revert, which has no sequencer, by its REVERT_HEAD", async () => {
    write("REVERT_HEAD", `${OID_A}\n`);
    const first = await readRepoOperationId(gitDir, "REVERTING");
    expect(first).toEqual(expect.any(String));
    // The same commit reverted again: only the new file's identity differs.
    await recreate("REVERT_HEAD", `${OID_A}\n`);
    const second = await readRepoOperationId(gitDir, "REVERTING");
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });

  it("never identifies two kinds the same, or a state with no operation", async () => {
    // Both kinds anchor on the one sequencer file here, so only the kind differs.
    write("sequencer/head", `${OID_A}\n`);
    const pick = await readRepoOperationId(gitDir, "CHERRY_PICKING");
    const revert = await readRepoOperationId(gitDir, "REVERTING");
    expect(pick).toEqual(expect.any(String));
    expect(revert).toEqual(expect.any(String));
    expect(pick).not.toBe(revert);
    fs.rmSync(path.join(gitDir, "sequencer"), { recursive: true });
    expect(await readRepoOperationId(gitDir, "CLEAN")).toBeNull();
    expect(await readRepoOperationId(gitDir, "DIRTY")).toBeNull();
    expect(await readRepoOperationId(gitDir, "MERGING")).toBeNull();
  });

  it("classifies the state itself when the caller hasn't", async () => {
    expect(await readCurrentRepoOperationId(gitDir)).toBeNull();
    write("MERGE_HEAD", `${OID_A}\n`);
    expect(await readCurrentRepoOperationId(gitDir)).toBe(
      await readRepoOperationId(gitDir, "MERGING")
    );
    // A rebase outranks a leftover MERGE_HEAD, as it does in the state itself.
    write("rebase-merge/orig-head", `${OID_B}\n`);
    expect(await readCurrentRepoOperationId(gitDir)).toBe(
      await readRepoOperationId(gitDir, "REBASING")
    );
  });

  it("classifies a `git am` session as its own state, not the rebase it shares a dir with", async () => {
    write("rebase-apply/applying", "");
    write("rebase-apply/next", "1\n");
    const id = await readCurrentRepoOperationId(gitDir);
    expect(id).toEqual(expect.any(String));
    expect(id).toBe(await readRepoOperationId(gitDir, "APPLYING_MAILBOX"));
  });
});
