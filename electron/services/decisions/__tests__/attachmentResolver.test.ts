import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeError, type QuestionOrigin } from "@daintreehq/decisions-client";
import { LIMITS } from "@daintreehq/decisions-protocol";
import { createWorktreeAttachmentResolver, isInsideRoot } from "../attachmentResolver.js";

/** Planted in every file, so a test can prove no refusal repeats what it read. */
const SECRET = "SECRET-FILE-CONTENT-never-echoed";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

function withSecret(header: Uint8Array): Buffer {
  return Buffer.concat([header, Buffer.from(SECRET)]);
}

let base: string;
let worktree: string;
let outside: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-attach-"));
  worktree = path.join(base, "worktree");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(worktree, "shots"), { recursive: true });
  fs.mkdirSync(outside);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function origin(root: string = worktree): QuestionOrigin {
  return {
    host_id: "host_a",
    pane_id: "pane-1",
    terminal_generation: 1,
    ownership_principal: "principal-1",
    agent_incarnation: "0",
    agent_kind: "claude",
    agent_session_id: null,
    project_id: "p1",
    worktree_id: root,
    worktree_root: root,
    workflow_gate_id: null,
  };
}

async function refusal(id: string, root?: string): Promise<BridgeError> {
  const error = await createWorktreeAttachmentResolver()
    .resolve(origin(root), id)
    .then(
      () => null,
      (e: unknown) => e
    );
  expect(error).toBeInstanceOf(BridgeError);
  const bridgeError = error as BridgeError;
  expect(bridgeError.code).toBe("attachment_error");
  expect(bridgeError.message).not.toContain(SECRET);
  return bridgeError;
}

describe("createWorktreeAttachmentResolver", () => {
  it("reads PNG, JPEG and WebP images by their path in the pane's worktree", async () => {
    const resolver = createWorktreeAttachmentResolver();
    for (const [name, header] of [
      ["shots/after.png", PNG],
      ["before.jpg", JPEG],
      ["shots/ref.webp", WEBP],
    ] as const) {
      const bytes = withSecret(header);
      fs.writeFileSync(path.join(worktree, name), bytes);
      const resolved = await resolver.resolve(origin(), name);
      expect(Buffer.from(resolved!.bytes).equals(bytes)).toBe(true);
    }
  });

  it("takes an absolute path that lands inside the worktree", async () => {
    const file = path.join(worktree, "shots", "after.png");
    fs.writeFileSync(file, withSecret(PNG));
    const resolved = await createWorktreeAttachmentResolver().resolve(origin(), file);
    expect(resolved?.bytes.length).toBe(PNG.length + SECRET.length);
  });

  it("follows a symlink that stays inside the worktree", async () => {
    fs.writeFileSync(path.join(worktree, "shots", "real.png"), withSecret(PNG));
    fs.symlinkSync(path.join(worktree, "shots", "real.png"), path.join(worktree, "latest.png"));
    const resolved = await createWorktreeAttachmentResolver().resolve(origin(), "latest.png");
    expect(resolved?.bytes.length).toBe(PNG.length + SECRET.length);
  });

  it("refuses a path that climbs out of the worktree", async () => {
    fs.writeFileSync(path.join(outside, "secret.png"), withSecret(PNG));
    expect((await refusal("../outside/secret.png")).message).toMatch(/outside this terminal's worktree/);
    expect((await refusal("shots/../../outside/secret.png")).message).toMatch(/outside/);
  });

  it("refuses an absolute path outside the worktree", async () => {
    const file = path.join(outside, "secret.png");
    fs.writeFileSync(file, withSecret(PNG));
    expect((await refusal(file)).message).toMatch(/outside this terminal's worktree/);
  });

  it("refuses a sibling directory whose name only starts like the worktree's", async () => {
    const sibling = `${worktree}-evil`;
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "shot.png"), withSecret(PNG));
    expect((await refusal(path.join(sibling, "shot.png"))).message).toMatch(/outside/);
  });

  it("refuses a symlinked file that points outside the worktree", async () => {
    fs.writeFileSync(path.join(outside, "secret.png"), withSecret(PNG));
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(worktree, "shots", "escape.png"));
    expect((await refusal("shots/escape.png")).message).toMatch(/outside this terminal's worktree/);
  });

  it("refuses a file reached through a symlinked directory outside the worktree", async () => {
    fs.writeFileSync(path.join(outside, "secret.png"), withSecret(PNG));
    fs.symlinkSync(outside, path.join(worktree, "linked"), "dir");
    expect((await refusal("linked/secret.png")).message).toMatch(/outside this terminal's worktree/);
  });

  it("refuses a file whose name says image but whose content isn't one", async () => {
    fs.writeFileSync(path.join(worktree, "shots", "fake.png"), `not an image: ${SECRET}`);
    expect((await refusal("shots/fake.png")).message).toMatch(/isn't a PNG, JPEG or WebP image/);
  });

  it("refuses SVG, even named as a PNG", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${SECRET}</text></svg>`;
    fs.writeFileSync(path.join(worktree, "icon.svg"), svg);
    fs.writeFileSync(path.join(worktree, "icon.png"), svg);
    expect((await refusal("icon.svg")).message).toMatch(/SVG is refused/);
    expect((await refusal("icon.png")).message).toMatch(/isn't a PNG, JPEG or WebP image/);
  });

  it("refuses a file over 20 MiB without reading it, and takes one of exactly 20 MiB", async () => {
    const big = path.join(worktree, "big.png");
    fs.writeFileSync(big, PNG);
    fs.truncateSync(big, LIMITS.attachmentBytes + 1);
    expect((await refusal("big.png")).message).toMatch(/larger than 20 MiB/);

    fs.truncateSync(big, LIMITS.attachmentBytes);
    const resolved = await createWorktreeAttachmentResolver().resolve(origin(), "big.png");
    expect(resolved?.bytes.length).toBe(LIMITS.attachmentBytes);
  });

  it("refuses an empty file, a directory, the worktree itself and a missing file", async () => {
    fs.writeFileSync(path.join(worktree, "empty.png"), "");
    expect((await refusal("empty.png")).message).toMatch(/is empty/);
    expect((await refusal("shots")).message).toMatch(/isn't a regular file/);
    expect((await refusal(".")).message).toMatch(/isn't a regular file/);
    expect((await refusal("shots/none.png")).message).toMatch(/isn't a file in this terminal's worktree/);
    expect((await refusal("empty.png/inner.png")).message).toMatch(/isn't a file/);
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without waiting on it", async () => {
    execFileSync("mkfifo", [path.join(worktree, "pipe.png")]);
    expect((await refusal("pipe.png")).message).toMatch(/isn't a regular file/);
  });

  it("refuses an empty, overlong or NUL-bearing id", async () => {
    const empty = await refusal("");
    expect(empty.message).toMatch(/empty/);
    const long = await refusal("a".repeat(5000));
    expect(long.message).toMatch(/too long/);
    expect(long.message.length).toBeLessThan(400);
    expect((await refusal("shot\0.png")).message).toMatch(/isn't a valid path/);
  });

  it("refuses everything for a pane with no launch worktree", async () => {
    fs.writeFileSync(path.join(worktree, "shot.png"), withSecret(PNG));
    expect((await refusal("shot.png", "")).message).toMatch(/no launch worktree/);
    expect((await refusal("shot.png", "relative/root")).message).toMatch(/no launch worktree/);
    expect((await refusal("shot.png", path.join(base, "gone"))).message).toMatch(
      /worktree can't be opened/
    );
  });
});

describe("isInsideRoot", () => {
  it("holds only for paths strictly below the root", () => {
    const root = path.resolve("/work/tree");
    expect(isInsideRoot(root, path.join(root, "a.png"))).toBe(true);
    expect(isInsideRoot(root, path.join(root, "..a", "b.png"))).toBe(true);
    expect(isInsideRoot(root, root)).toBe(false);
    expect(isInsideRoot(root, path.resolve("/work/tree-evil/a.png"))).toBe(false);
    expect(isInsideRoot(root, path.resolve("/work/a.png"))).toBe(false);
  });
});
