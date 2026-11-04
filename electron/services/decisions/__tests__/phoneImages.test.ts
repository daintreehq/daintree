// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isTypablePath,
  type InjectionIntent,
  type PhoneImageFile,
  type QuestionRow,
} from "@daintreehq/decisions-client";
import {
  DecisionsPhoneImages,
  PHONE_IMAGE_RETENTION_MS,
  erasePhoneImages,
  phoneImageRootsFile,
  type PhoneImageFacts,
} from "../phoneImages.js";
import { HANDLED_ANSWERS_META_KEY } from "../attentionList.js";
import { answers, message, qid, row } from "./questionRows.js";

const POSIX = process.platform !== "win32";
const DAY = 24 * 60 * 60 * 1000;

/** The smallest valid PNG: what a phone photo is, as far as storing goes. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d4944415478da63f8cfc0f01f0005000201a1b0b4" +
    "e60000000049454e44ae426082",
  "hex"
);

let dir: string;
let repo: string;
let rootsFile: string;
let rows: QuestionRow[];
let intents: InjectionIntent[];
let deleted: Set<string>;
let meta: Map<string, string>;
let clock: number;
const open: DecisionsPhoneImages[] = [];

const facts: PhoneImageFacts = {
  listQuestions: async () => rows,
  openIntents: async () => intents,
  deletedQuestionIds: async () => deleted,
  getMeta: async (key) => meta.get(key) ?? null,
  setMeta: async (key, value) => void meta.set(key, value),
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function images(options: Partial<ConstructorParameters<typeof DecisionsPhoneImages>[0]> = {}) {
  const made = new DecisionsPhoneImages({
    rootsFile,
    facts,
    now: () => clock,
    sweepIntervalMs: 0,
    ...options,
  });
  open.push(made);
  return made;
}

function image(overrides: Partial<PhoneImageFile> & { root?: string; bytes?: Uint8Array } = {}) {
  const { root = repo, bytes = PNG, ...rest } = overrides;
  return {
    questionId: qid(1),
    carrier: { kind: "answer", actionId: "action-1" },
    origin: { ...row(1).origin, worktree_root: root },
    attachmentId: "att_photo_1",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mime: "image/png",
    alt: "The label on the left connector",
    bytes,
    ...rest,
  } as PhoneImageFile;
}

/** Every file below `root` but Git's own, relative to it, with forward slashes. */
function filesUnder(root: string): string[] {
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((entry) => !entry.split(path.sep).includes(".git"))
    .filter((entry) => fs.lstatSync(path.join(root, entry)).isFile())
    .map((entry) => entry.split(path.sep).join("/"))
    .sort();
}

const mode = (p: string) => fs.statSync(p).mode & 0o777;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-phone-images-")));
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, ".daintree", "recipes"), { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  fs.writeFileSync(path.join(repo, ".daintree", "recipes", "build.json"), "{}\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "init");
  rootsFile = phoneImageRootsFile(path.join(dir, "userData", "decisions", "keys.bin"));
  rows = [row(1, { origin: { worktree_root: repo } })];
  intents = [];
  deleted = new Set();
  meta = new Map();
  clock = Date.now();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const made of open.splice(0)) await made.close();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("DecisionsPhoneImages.store (#16233)", () => {
  it("writes the photo under the asking pane's directory, readable, owner-only and out of Git", async () => {
    const tracked = git(repo, "ls-files");
    const { path: stored } = await images().store(image());

    expect(stored.startsWith(path.join(repo, ".daintree", "decisions", "images") + path.sep)).toBe(
      true
    );
    expect(path.basename(stored)).toBe("att_photo_1.png");
    expect(path.isAbsolute(stored)).toBe(true);
    expect(isTypablePath(stored)).toBe(true);
    expect(fs.readFileSync(stored).equals(PNG)).toBe(true);
    expect(stored).not.toContain("connector");

    // Nothing for Git to show or commit, and what the repository tracks is untouched.
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(repo, "ls-files")).toBe(tracked);
    expect(git(repo, "check-ignore", stored).trim()).toBe(stored);
    expect(fs.readFileSync(path.join(repo, ".daintree", "recipes", "build.json"), "utf8")).toBe(
      "{}\n"
    );
    expect(fs.readFileSync(path.join(repo, ".daintree", "decisions", ".gitignore"), "utf8")).toBe(
      "*\n"
    );

    if (POSIX) {
      expect(mode(stored)).toBe(0o600);
      for (let d = path.dirname(stored); d !== path.join(repo, ".daintree"); d = path.dirname(d)) {
        expect(mode(d)).toBe(0o700);
      }
    }
    // Recorded beside the keys, owner-only too.
    expect(JSON.parse(fs.readFileSync(rootsFile, "utf8")).roots).toEqual([repo]);
    if (POSIX) expect(mode(rootsFile)).toBe(0o600);
  });

  it.runIf(POSIX)("keeps the photo owner-only under a permissive umask", async () => {
    const previous = process.umask(0o000);
    try {
      const { path: stored } = await images().store(image());
      expect(mode(stored)).toBe(0o600);
      expect(mode(path.dirname(stored))).toBe(0o700);
    } finally {
      process.umask(previous);
    }
  });

  it("writes into the subdirectory an agent launched in, where its working directory is", async () => {
    const app = path.join(repo, "packages", "app");
    fs.mkdirSync(app, { recursive: true });
    const { path: stored } = await images().store(image({ root: app }));

    expect(stored.startsWith(path.join(app, ".daintree", "decisions") + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(repo, ".daintree", "decisions"))).toBe(false);
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("returns the same path for the same photo, and puts back one that was damaged", async () => {
    const store = images();
    const first = await store.store(image());
    const again = await store.store(image());
    expect(again.path).toBe(first.path);
    expect(fs.readdirSync(path.dirname(first.path))).toEqual(["att_photo_1.png"]);

    fs.writeFileSync(first.path, "not the photo");
    expect((await store.store(image())).path).toBe(first.path);
    expect(fs.readFileSync(first.path).equals(PNG)).toBe(true);
    expect(fs.readdirSync(path.dirname(first.path))).toEqual(["att_photo_1.png"]);
  });

  it("names each photo by its type", async () => {
    const store = images();
    const jpeg = await store.store(image({ attachmentId: "att_2", mime: "image/jpeg" }));
    const webp = await store.store(image({ attachmentId: "att_3", mime: "image/webp" }));
    expect([path.basename(jpeg.path), path.basename(webp.path)]).toEqual([
      "att_2.jpg",
      "att_3.webp",
    ]);
  });

  it.each([
    ["no directory", ""],
    ["a relative directory", "repo"],
    ["a directory that's gone", "/nowhere/daintree-phone-images-missing"],
  ])("refuses a pane with %s, creating nothing", async (_label, root) => {
    await expect(images().store(image({ root }))).rejects.toThrow();
    expect(fs.existsSync(path.join(repo, ".daintree", "decisions"))).toBe(false);
    expect(fs.existsSync(rootsFile)).toBe(false);
  });

  it.each([
    ["a question id", { questionId: "../../etc" }],
    ["an attachment id", { attachmentId: "x/../../y" }],
  ])("refuses %s that could name another file", async (_label, overrides) => {
    await expect(images().store(image(overrides))).rejects.toThrow();
    expect(filesUnder(repo)).toEqual([".daintree/recipes/build.json", "README.md"]);
  });

  it("refuses bytes that don't match their digest", async () => {
    await expect(images().store({ ...image(), sha256: "0".repeat(64) })).rejects.toThrow();
  });

  it.runIf(POSIX)("never writes through a symlink a repository or an agent planted", async () => {
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    const linked = path.join(dir, "linked");
    fs.mkdirSync(linked);
    fs.symlinkSync(outside, path.join(linked, ".daintree"));
    await expect(images().store(image({ root: linked }))).rejects.toThrow();

    const deep = path.join(dir, "deep");
    fs.mkdirSync(path.join(deep, ".daintree", "decisions"), { recursive: true });
    fs.writeFileSync(path.join(deep, ".daintree", "decisions", ".gitignore"), "*\n");
    fs.symlinkSync(outside, path.join(deep, ".daintree", "decisions", "images"));
    await expect(images().store(image({ root: deep }))).rejects.toThrow();

    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses a .gitignore there that isn't Daintree's, and changes nothing", async () => {
    const decisions = path.join(repo, ".daintree", "decisions");
    fs.mkdirSync(decisions);
    fs.writeFileSync(path.join(decisions, ".gitignore"), "!*.png\n");
    await expect(images().store(image())).rejects.toThrow();
    expect(fs.readFileSync(path.join(decisions, ".gitignore"), "utf8")).toBe("!*.png\n");
    expect(fs.existsSync(path.join(decisions, "images"))).toBe(false);
  });

  it("takes nothing once closed", async () => {
    const store = images();
    await store.close();
    await expect(store.store(image())).rejects.toThrow();
    expect(fs.existsSync(path.join(repo, ".daintree", "decisions"))).toBe(false);
  });
});

describe("DecisionsPhoneImages sweeps (#16233)", () => {
  async function stored(store: DecisionsPhoneImages, overrides: Partial<PhoneImageFile> = {}) {
    return (await store.store(image(overrides))).path;
  }

  it("deletes a question's photos once the relay deleted it, and forgets a root left empty", async () => {
    rows = [
      row(1, { origin: { worktree_root: repo } }),
      row(2, { origin: { worktree_root: repo } }),
    ];
    const store = images();
    const gone = await stored(store);
    const kept = await stored(store, { questionId: qid(2), attachmentId: "att_other" });

    deleted.add(qid(1));
    await store.sweep();
    expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(path.dirname(gone))).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);

    deleted.add(qid(2));
    await store.sweep();
    expect(fs.existsSync(kept)).toBe(false);
    expect(fs.existsSync(rootsFile)).toBe(false);
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("keeps photos while their answer waits to be typed, and for the retention period after", async () => {
    rows = [row(1, { origin: { worktree_root: repo }, answers_json: answers({}) })];
    const store = images();
    const photo = await stored(store);

    // Waiting far past the retention period: kept, and its time starts only once nothing waits.
    clock += PHONE_IMAGE_RETENTION_MS + DAY;
    await store.sweep();
    expect(fs.existsSync(photo)).toBe(true);
    const typedAt = clock;

    rows = [
      row(1, { origin: { worktree_root: repo }, answers_json: answers({ delivered: true }) }),
    ];
    clock = typedAt + PHONE_IMAGE_RETENTION_MS - DAY;
    await store.sweep();
    expect(fs.existsSync(photo)).toBe(true);

    clock = typedAt + PHONE_IMAGE_RETENTION_MS + 1;
    await store.sweep();
    expect(fs.existsSync(photo)).toBe(false);
  });

  it("keeps photos for a follow-up waiting, or an injection not settled", async () => {
    rows = [
      row(1, {
        origin: { worktree_root: repo },
        messages_json: JSON.stringify([message({ delivery: { status: "needs-attention" } })]),
      }),
      row(2, { origin: { worktree_root: repo }, answers_json: answers({ delivered: true }) }),
    ];
    intents = [{ question_id: qid(2) } as InjectionIntent];
    const store = images();
    const followUp = await stored(store);
    const answered = await stored(store, { questionId: qid(2), attachmentId: "att_2" });

    clock += PHONE_IMAGE_RETENTION_MS + DAY;
    await store.sweep();
    expect(fs.existsSync(followUp)).toBe(true);
    expect(fs.existsSync(answered)).toBe(true);
  });

  it("lets a photo go on time once a person marked its answer handled", async () => {
    const asked = "0190f0aa11112222333344445555aaaa";
    rows = [
      row(1, {
        question_id: asked,
        origin: { worktree_root: repo },
        delivery_status: "needs-attention",
        answers_json: answers({}),
      }),
    ];
    meta.set(HANDLED_ANSWERS_META_KEY, JSON.stringify({ [asked]: 1 }));
    const store = images();
    const photo = await stored(store, { questionId: asked });
    // Written a moment after the clock was read.
    clock += PHONE_IMAGE_RETENTION_MS + 60_000;
    await store.sweep();
    expect(fs.existsSync(photo)).toBe(false);
  });

  it("deletes photos whose question this store no longer has, never another installation's", async () => {
    const store = images();
    const photo = await stored(store);
    const theirs = path.join(
      repo,
      ".daintree",
      "decisions",
      "images",
      "f".repeat(32),
      qid(1),
      "att_photo_1.png"
    );
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, PNG);

    rows = [];
    await store.sweep();
    expect(fs.existsSync(photo)).toBe(false);
    expect(fs.existsSync(theirs)).toBe(true);
  });

  it("clears a part file an interrupted write left, and deletes nothing when the facts can't be read", async () => {
    const store = images();
    const photo = await stored(store);
    const part = path.join(path.dirname(photo), ".part-0123456789abcdef");
    fs.writeFileSync(part, "half a photo");
    await store.sweep();
    expect(fs.existsSync(part)).toBe(false);

    rows = [];
    const unreadable = images({
      facts: {
        ...facts,
        listQuestions: async () => {
          throw new Error("store closed");
        },
      },
    });
    await unreadable.sweep();
    expect(fs.existsSync(photo)).toBe(true);
  });

  it("sweeps when it opens, so photos a lifetime left for gone questions go first", async () => {
    const photo = await stored(images());
    rows = [];
    const next = images();
    await next.sweep();
    expect(fs.existsSync(photo)).toBe(false);
  });

  it.runIf(POSIX)("never deletes through a symlink planted in its directory", async () => {
    const store = images();
    const photo = await stored(store);
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "mine");
    const images_ = path.dirname(path.dirname(photo));
    fs.symlinkSync(outside, path.join(images_, qid(9)));
    fs.symlinkSync(path.join(outside, "keep.txt"), path.join(path.dirname(photo), "link.png"));

    rows = [];
    await store.sweep();
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("mine");
  });
});

describe("erasePhoneImages (#16233)", () => {
  it("deletes every photo in every directory recorded, and the record, leaving the rest", async () => {
    const other = path.join(dir, "other");
    fs.mkdirSync(other);
    rows = [
      row(1, { origin: { worktree_root: repo } }),
      row(2, { origin: { worktree_root: other } }),
    ];
    const store = images();
    const first = (await store.store(image())).path;
    const second = (await store.store(image({ root: other, questionId: qid(2) }))).path;
    await store.close();

    expect(await erasePhoneImages(rootsFile)).toBe(true);
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.existsSync(rootsFile)).toBe(false);
    expect(filesUnder(repo)).toEqual([
      ".daintree/decisions/.gitignore",
      ".daintree/recipes/build.json",
      "README.md",
    ]);
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("is done when nothing was ever stored", async () => {
    expect(await erasePhoneImages(rootsFile)).toBe(true);
  });
});
