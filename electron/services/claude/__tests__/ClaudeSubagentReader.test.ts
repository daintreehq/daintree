import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  CLAUDE_SUBAGENT_ACTIVE_WINDOW_MS,
  __resetClaudeSubagentProbeCache,
  deriveProjectSlug,
  findSubagentsDir,
  humanizeAgentType,
  inferStatus,
  isSafeSubagentId,
  listSubagentsInDir,
  parseSubagentMeta,
  readTranscriptFile,
  recordText,
  resolveClaudeConfigDir,
} from "../ClaudeSubagentReader.js";
import { SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT } from "../../../../shared/types/ipc/agentSubagents.js";

let root: string;

beforeEach(async () => {
  __resetClaudeSubagentProbeCache();
  root = await mkdtemp(path.join(tmpdir(), "claude-subagents-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const SESSION = "1ad2578c-b710-4302-90c1-b222c4c29aa2";

function record(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function userRecord(text: string, extra: Record<string, unknown> = {}): string {
  return record({
    type: "user",
    isSidechain: true,
    message: { role: "user", content: text },
    timestamp: "2026-08-01T19:28:19.515Z",
    ...extra,
  });
}

function assistantRecord(
  text: string,
  stopReason: string | null,
  extra: Record<string, unknown> = {}
): string {
  return record({
    type: "assistant",
    isSidechain: true,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
    },
    timestamp: "2026-08-01T19:28:35.232Z",
    ...extra,
  });
}

async function writeChild(
  dir: string,
  id: string,
  lines: string[],
  meta?: Record<string, unknown>
): Promise<string> {
  const file = path.join(dir, `agent-${id}.jsonl`);
  await writeFile(file, lines.join("\n") + "\n", "utf8");
  if (meta) {
    await writeFile(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(meta), "utf8");
  }
  return file;
}

async function makeSubagentsDir(slugSource: string): Promise<string> {
  const dir = path.join(root, "projects", deriveProjectSlug(slugSource), SESSION, "subagents");
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("resolveClaudeConfigDir", () => {
  it("prefers the CLI's own override over the home-relative default", () => {
    const overridden = resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/custom/claude" });
    const defaulted = resolveClaudeConfigDir({});
    expect(overridden).toBe(path.resolve("/custom/claude"));
    expect(defaulted).not.toBe(overridden);
    expect(defaulted.endsWith(path.join(".claude"))).toBe(true);
  });

  it("ignores an override that is only whitespace", () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "   " })).toBe(resolveClaudeConfigDir({}));
  });
});

describe("deriveProjectSlug", () => {
  it("replaces separators without disturbing dashes already in the path", () => {
    expect(deriveProjectSlug("/Users/x/Projects/daintree-worktrees/feature-a")).toBe(
      "-Users-x-Projects-daintree-worktrees-feature-a"
    );
  });
});

describe("findSubagentsDir", () => {
  it("finds the directory the slug rule predicts", async () => {
    const cwd = "/Users/x/Projects/demo";
    const expected = await makeSubagentsDir(cwd);
    await expect(findSubagentsDir(cwd, SESSION, { configDir: root })).resolves.toBe(expected);
  });

  it("still finds the session when the slug rule does not describe this path", async () => {
    // Stands in for any encoding the undocumented slug algorithm applies that
    // we have not observed — a Windows drive letter, a dot, a space.
    const stored = path.join(root, "projects", "an-encoding-we-did-not-predict", SESSION);
    await mkdir(path.join(stored, "subagents"), { recursive: true });
    await expect(
      findSubagentsDir("/Users/x/Projects/demo", SESSION, { configDir: root })
    ).resolves.toBe(path.join(stored, "subagents"));
  });

  it("reports nothing rather than a path when the session has never delegated", async () => {
    await mkdir(path.join(root, "projects"), { recursive: true });
    await expect(
      findSubagentsDir("/Users/x/Projects/demo", SESSION, { configDir: root })
    ).resolves.toBeNull();
  });

  it("refuses a session id that could climb out of the projects root", async () => {
    await mkdir(path.join(root, "projects"), { recursive: true });
    await expect(
      findSubagentsDir("/Users/x/Projects/demo", "../../etc", { configDir: root })
    ).resolves.toBeNull();
  });
});

describe("isSafeSubagentId", () => {
  it("accepts a real agent id and refuses anything that could steer a path", () => {
    expect(isSafeSubagentId("a20ff1d9e5d1d0eaa")).toBe(true);
    for (const hostile of ["../secret", "a/b", "a\\b", "", "a.jsonl", "a\0b", "a".repeat(129)]) {
      expect(isSafeSubagentId(hostile)).toBe(false);
    }
  });
});

describe("humanizeAgentType", () => {
  it("turns the recorded slug into something a row can show", () => {
    expect(humanizeAgentType("general-purpose")).toBe("General purpose");
    expect(humanizeAgentType("code_reviewer")).toBe("Code reviewer");
  });

  it("has nothing to show for a missing or blank type", () => {
    expect(humanizeAgentType(null)).toBeNull();
    expect(humanizeAgentType("   ")).toBeNull();
  });
});

describe("parseSubagentMeta", () => {
  it("reads the fields a sidecar carries only when the caller supplied them", () => {
    const full = parseSubagentMeta(
      JSON.stringify({
        agentType: "general-purpose",
        description: "Run the palette suite",
        toolUseId: "toolu_01",
        spawnDepth: 2,
        model: "haiku",
      }),
      10
    );
    expect(full.description).toBe("Run the palette suite");
    expect(full.depth).toBe(2);
    expect(full.model).toBe("haiku");

    const bare = parseSubagentMeta(
      JSON.stringify({ agentType: "general-purpose", spawnDepth: 1, model: "claude-sonnet-5" }),
      10
    );
    expect(bare.description).toBeNull();
    expect(bare.agentType).toBe("general-purpose");
  });

  it("costs a malformed sidecar its fields, not the row", () => {
    const parsed = parseSubagentMeta("{not json", 42);
    expect(parsed.agentType).toBeNull();
    expect(parsed.createdAt).toBe(42);
  });

  it("drops a depth that is not a finite number rather than passing it through", () => {
    expect(parseSubagentMeta(JSON.stringify({ spawnDepth: "1" }), null).depth).toBeNull();
    expect(parseSubagentMeta(JSON.stringify({ spawnDepth: Number.NaN }), null).depth).toBeNull();
  });
});

describe("recordText", () => {
  it("reads the delegated prompt whether it arrives as a string or as blocks", () => {
    expect(recordText({ content: "do the thing" })).toBe("do the thing");
    expect(recordText({ content: [{ type: "text", text: "do the thing" }] })).toBe("do the thing");
  });

  it("keeps the answer and drops the scratchpad and the mechanism around it", () => {
    const text = recordText({
      content: [
        { type: "thinking", thinking: "let me consider" },
        { type: "text", text: "the answer" },
        { type: "tool_use", name: "Bash", input: { command: "rm -rf /" } },
      ],
    });
    expect(text).toBe("the answer");
  });

  it("does not put tool output on the wire", () => {
    const text = recordText({
      content: [{ type: "tool_result", content: "contents of a private file" }],
    });
    expect(text).toBe("");
  });
});

describe("inferStatus", () => {
  const now = 1_000_000_000;

  it("calls a settled final turn done", () => {
    const last = { type: "assistant", message: { stop_reason: "end_turn" }, timestamp: null };
    expect(inferStatus(last, now, now)).toEqual({ type: "completed" });
  });

  it("does not call a child done just because it paused to use a tool", () => {
    const last = { type: "assistant", message: { stop_reason: "tool_use" }, timestamp: null };
    expect(inferStatus(last, now, now)).toEqual({ type: "working" });
  });

  it("treats a still-changing unfinished child as working", () => {
    const last = { type: "user", message: { content: [] }, timestamp: null };
    expect(inferStatus(last, now - 1_000, now)).toEqual({ type: "working" });
  });

  it("admits it cannot tell once an unfinished child goes quiet, rather than calling it failed", () => {
    const last = { type: "assistant", message: { stop_reason: "tool_use" }, timestamp: null };
    const status = inferStatus(last, now - CLAUDE_SUBAGENT_ACTIVE_WINDOW_MS - 1, now);
    expect(status).toEqual({ type: "unknown", reason: "stale" });
  });

  it("keeps a finished child done however long ago it finished", () => {
    const last = { type: "assistant", message: { stop_reason: "end_turn" }, timestamp: null };
    expect(inferStatus(last, now - 30 * 24 * 3_600_000, now)).toEqual({ type: "completed" });
  });

  it("separates an unreadable record from an idle one", () => {
    expect(inferStatus(null, now, now)).toEqual({ type: "unknown", reason: "unrecognized" });
  });
});

describe("listSubagentsInDir", () => {
  it("prefers the description the parent wrote over the category it belongs to", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(
      dir,
      "aaa1",
      [userRecord("Run the suite"), assistantRecord("done", "end_turn")],
      {
        agentType: "general-purpose",
        description: "Run the palette suite",
        spawnDepth: 1,
        model: "haiku",
      }
    );

    const [child] = await listSubagentsInDir(dir);
    expect(child?.label).toBe("Run the palette suite");
    expect(child?.role).toBe("General purpose");
    expect(child?.preview).toBe("Run the suite");
    expect(child?.model).toBe("haiku");
  });

  it("still lists a child whose sidecar was never written", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [
      userRecord("Run the suite"),
      assistantRecord("done", "end_turn"),
    ]);

    const [child] = await listSubagentsInDir(dir);
    expect(child?.id).toBe("aaa1");
    expect(child?.label).toBeNull();
    // With no sidecar to date the spawn, the first record is what remains.
    expect(child?.createdAt).toBe(Date.parse("2026-08-01T19:28:19.515Z"));
  });

  it("orders children by most recent activity so the live one leads", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    const older = await writeChild(dir, "aaa1", [userRecord("first")]);
    const newer = await writeChild(dir, "bbb2", [userRecord("second")]);
    const base = new Date(1_700_000_000_000);
    await utimes(older, base, base);
    await utimes(newer, base, new Date(1_700_000_500_000));

    const ids = (await listSubagentsInDir(dir)).map((child) => child.id);
    expect(ids).toEqual(["bbb2", "aaa1"]);
  });

  it("ignores files in the directory that are not a child transcript", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [userRecord("real")]);
    await writeFile(path.join(dir, "notes.txt"), "ignore me", "utf8");
    await writeFile(path.join(dir, "agent-.jsonl"), "{}", "utf8");

    expect((await listSubagentsInDir(dir)).map((c) => c.id)).toEqual(["aaa1"]);
  });

  it("returns nothing for a directory that is not there", async () => {
    await expect(listSubagentsInDir(path.join(root, "absent"))).resolves.toEqual([]);
  });

  it("reads status from the real last record, not a stale one further up", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [
      userRecord("go"),
      assistantRecord("interim", "end_turn"),
      assistantRecord("still working", "tool_use"),
    ]);

    const [child] = await listSubagentsInDir(dir);
    expect(child?.status.type).not.toBe("completed");
  });

  it("re-reads a child that has written since the last look", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    const file = await writeChild(dir, "aaa1", [
      userRecord("go"),
      assistantRecord("thinking", "tool_use"),
    ]);
    const first = await listSubagentsInDir(dir);
    expect(first[0]?.status.type).not.toBe("completed");

    await writeFile(
      file,
      [
        userRecord("go"),
        assistantRecord("thinking", "tool_use"),
        assistantRecord("done", "end_turn"),
      ].join("\n") + "\n",
      "utf8"
    );
    const second = await listSubagentsInDir(dir);
    expect(second[0]?.status).toEqual({ type: "completed" });
  });
});

describe("readTranscriptFile", () => {
  it("keeps the task and the reply and drops everything between them", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    const file = await writeChild(dir, "aaa1", [
      userRecord("Run the suite"),
      assistantRecord("checking", "tool_use"),
      record({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "secret file body" }] },
      }),
      record({ type: "attachment", message: { content: "attached" } }),
      assistantRecord("all green", "end_turn"),
    ]);

    const { messages, truncated } = await readTranscriptFile(file);
    expect(messages).toEqual([
      { role: "task", text: "Run the suite" },
      { role: "reply", text: "checking" },
      { role: "reply", text: "all green" },
    ]);
    expect(truncated).toBe(false);
  });

  it("keeps the delegated task when the cap forces messages out", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    const lines = [userRecord("the original task")];
    for (let index = 0; index < SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT + 5; index += 1) {
      lines.push(assistantRecord(`reply ${index}`, "tool_use"));
    }
    const file = await writeChild(dir, "aaa1", lines);

    const { messages, truncated } = await readTranscriptFile(file);
    expect(truncated).toBe(true);
    expect(messages.length).toBe(SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT);
    expect(messages[0]).toEqual({ role: "task", text: "the original task" });
    // The newest reply is what the reader came for, so it must survive too.
    expect(messages.at(-1)?.text).toBe(`reply ${SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT + 4}`);
  });

  it("skips a corrupt line instead of abandoning the transcript", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    const file = await writeChild(dir, "aaa1", [
      userRecord("go"),
      "{ truncated mid-write",
      assistantRecord("done", "end_turn"),
    ]);

    const { messages } = await readTranscriptFile(file);
    expect(messages.map((m) => m.text)).toEqual(["go", "done"]);
  });
});
