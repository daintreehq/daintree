import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const host = vi.hoisted(() => ({
  resolveClaudeTerminal: vi.fn(),
  getClaudePaneProjectsRoot: vi.fn(),
}));

vi.mock("../ClaudeSubagentService.js", () => ({
  resolveClaudeTerminal: host.resolveClaudeTerminal,
}));
vi.mock("../ClaudeSessionStore.js", () => ({
  getClaudePaneProjectsRoot: host.getClaudePaneProjectsRoot,
}));

import { findClaudeReplySpan } from "../ClaudeReplyCopy.js";
import { deriveProjectSlug } from "../ClaudeSubagentReader.js";

const SESSION = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const CWD = "/Users/x/Projects/demo";
const REPLY = "Run the **build** first, then `npm test` before you push.";

let root: string;
let projectsRoot: string;
let transcript: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "claude-reply-copy-"));
  projectsRoot = path.join(root, "projects");
  const dir = path.join(projectsRoot, deriveProjectSlug(CWD));
  await mkdir(dir, { recursive: true });
  transcript = path.join(dir, `${SESSION}.jsonl`);
  const record = {
    type: "assistant",
    message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: REPLY }] },
  };
  await writeFile(transcript, `${JSON.stringify(record)}\n`, "utf8");
  host.resolveClaudeTerminal.mockResolvedValue({ cwd: CWD, parentSessionId: SESSION });
  host.getClaudePaneProjectsRoot.mockReturnValue(projectsRoot);
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

const live = () => new AbortController().signal;

describe("findClaudeReplySpan", () => {
  it("finds the selection in the pane's own transcript and leaves the store as it was", async () => {
    const before = await stat(transcript);

    const span = await findClaudeReplySpan(
      "t-1",
      "⏺ Run the build first, then npm test\n  before you push.",
      live()
    );

    expect(span).toBe(REPLY);
    expect(host.resolveClaudeTerminal).toHaveBeenCalledWith("t-1");
    expect(await readdir(path.dirname(transcript))).toEqual([path.basename(transcript)]);
    expect((await stat(transcript)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(transcript, "utf8")).toContain(REPLY);
  });

  it("has nothing for a selection no reply holds", async () => {
    expect(await findClaudeReplySpan("t-1", "⎿  Read 12 lines", live())).toBeNull();
  });

  it("reads nothing for a pane that isn't running Claude Code", async () => {
    host.resolveClaudeTerminal.mockResolvedValue({
      status: "unavailable",
      reason: "provider-mismatch",
    });

    expect(await findClaudeReplySpan("t-1", "Run the build first", live())).toBeNull();
    expect(host.getClaudePaneProjectsRoot).not.toHaveBeenCalled();
  });

  it("reads nothing when the pane's store was never pinned down", async () => {
    host.getClaudePaneProjectsRoot.mockReturnValue(null);

    expect(await findClaudeReplySpan("t-1", "Run the build first", live())).toBeNull();
  });

  it("gives up once the deadline has passed", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      findClaudeReplySpan("t-1", "Run the build first", controller.signal)
    ).rejects.toThrow();
  });
});
