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

import { readClaudePaneContextUsage } from "../ClaudeContextUsage.js";
import { deriveProjectSlug } from "../ClaudeSubagentReader.js";

const SESSION = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const CWD = "/Users/x/Projects/demo";
const STAMP = "2026-09-18T10:00:00.000Z";

let root: string;
let projectsRoot: string;
let transcript: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "claude-context-usage-"));
  projectsRoot = path.join(root, "projects");
  const dir = path.join(projectsRoot, deriveProjectSlug(CWD));
  await mkdir(dir, { recursive: true });
  transcript = path.join(dir, `${SESSION}.jsonl`);
  const record = {
    type: "assistant",
    isSidechain: false,
    timestamp: STAMP,
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      usage: {
        input_tokens: 4,
        cache_creation_input_tokens: 1_098,
        cache_read_input_tokens: 125_615,
        output_tokens: 385,
      },
    },
  };
  await writeFile(transcript, `${JSON.stringify(record)}\n`, "utf8");
  host.resolveClaudeTerminal.mockResolvedValue({ cwd: CWD, parentSessionId: SESSION });
  host.getClaudePaneProjectsRoot.mockReturnValue(projectsRoot);
});

afterEach(async () => {
  host.resolveClaudeTerminal.mockReset();
  host.getClaudePaneProjectsRoot.mockReset();
  await rm(root, { recursive: true, force: true });
});

const live = () => new AbortController().signal;

describe("readClaudePaneContextUsage", () => {
  it("reads the pane's own transcript and leaves the store as it was", async () => {
    const before = await stat(transcript);
    const content = await readFile(transcript, "utf8");

    const result = await readClaudePaneContextUsage("t-1", live());

    expect(result).toEqual({
      status: "ok",
      provider: "claude",
      contextTokens: 126_717,
      recordedAt: Date.parse(STAMP),
    });
    expect(host.resolveClaudeTerminal).toHaveBeenCalledWith("t-1");
    expect(host.getClaudePaneProjectsRoot).toHaveBeenCalledWith("t-1");
    const after = await stat(transcript);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(transcript, "utf8")).toBe(content);
    expect(await readdir(path.dirname(transcript))).toEqual([`${SESSION}.jsonl`]);
  });

  it("passes on why the pane can't be read", async () => {
    host.resolveClaudeTerminal.mockResolvedValue({
      status: "unavailable",
      reason: "provider-mismatch",
    });

    expect(await readClaudePaneContextUsage("t-1", live())).toEqual({
      status: "unavailable",
      reason: "provider-mismatch",
    });
    expect(host.getClaudePaneProjectsRoot).not.toHaveBeenCalled();
  });

  it("reads nothing when the pane's store was never pinned down", async () => {
    host.getClaudePaneProjectsRoot.mockReturnValue(null);

    expect(await readClaudePaneContextUsage("t-1", live())).toEqual({
      status: "unavailable",
      reason: "store-unknown",
    });
  });

  it("does nothing once the request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(readClaudePaneContextUsage("t-1", controller.signal)).rejects.toThrow();
    expect(host.resolveClaudeTerminal).not.toHaveBeenCalled();
  });
});
