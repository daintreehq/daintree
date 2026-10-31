import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { chmod, lstat, mkdtemp, mkdir, rename, rm, symlink, writeFile, utimes } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  CLAUDE_SUBAGENT_ACTIVE_WINDOW_MS,
  WarmCache,
  __claudeSubagentCacheStats,
  __resetClaudeSubagentCaches,
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
import {
  SUBAGENT_LIST_LIMIT,
  SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT,
} from "../../../../shared/types/ipc/agentSubagents.js";

/** Every path the reader opens, so a test can tell a cache hit from a re-read. */
const opened = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    opened.paths.push(String(args[0]));
    return actual.open(...args);
  }) as typeof actual.open;
  return { ...actual, open, default: { ...actual, open } };
});

function opensOf(suffix: string): number {
  return opened.paths.filter((file) => file.endsWith(suffix)).length;
}

let root: string;

beforeEach(async () => {
  opened.paths.length = 0;
  __resetClaudeSubagentCaches();
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

  it("turns every other non-alphanumeric character into a dash, as Claude Code does", () => {
    expect(deriveProjectSlug("/Users/john.smith/.claude/worktrees/my_app v2")).toBe(
      "-Users-john-smith--claude-worktrees-my-app-v2"
    );
  });

  it("encodes a Windows drive path the way Claude Code names its directory", () => {
    expect(deriveProjectSlug("C:\\Users\\me\\Projects\\app")).toBe("C--Users-me-Projects-app");
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
    // Baited: the traversal target exists, so only the guard can be what stops it.
    const escape = path.join(root, "etc", "subagents");
    await mkdir(escape, { recursive: true });
    await mkdir(path.join(root, "projects", "slug"), { recursive: true });
    await expect(
      findSubagentsDir("/Users/x/Projects/demo", "../../etc", { configDir: root })
    ).resolves.toBeNull();
  });

  it("refuses a session directory that is a symlink out of the store", async () => {
    const outside = path.join(root, "outside", SESSION, "subagents");
    await mkdir(outside, { recursive: true });
    const slugDir = path.join(root, "projects", deriveProjectSlug("/Users/x/Projects/demo"));
    await mkdir(slugDir, { recursive: true });
    await symlink(path.join(root, "outside", SESSION), path.join(slugDir, SESSION));

    await expect(
      findSubagentsDir("/Users/x/Projects/demo", SESSION, { configDir: root })
    ).resolves.toBeNull();
  });
});

describe("isSafeSubagentId", () => {
  it("accepts a real agent id and refuses anything that could steer a path", () => {
    expect(isSafeSubagentId("a20ff1d9e5d1d0eaa")).toBe(true);
    for (const hostile of ["../secret", "a/b", "a\\b", "", "a.jsonl", "a\0b"]) {
      expect(isSafeSubagentId(hostile)).toBe(false);
    }
    // Bounded rather than a specific length: an id long enough to be a
    // filename attack is refused wherever the boundary sits.
    expect(isSafeSubagentId("a".repeat(4096))).toBe(false);
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
    // Written as raw JSON: `JSON.stringify` turns both NaN and Infinity into
    // `null`, so a stringified fixture would never exercise this at all.
    expect(parseSubagentMeta('{"spawnDepth":1e400}', null).depth).toBeNull();
  });

  it("takes nothing from a sidecar that parsed into something other than an object", () => {
    expect(parseSubagentMeta("[1,2,3]", 5).agentType).toBeNull();
    expect(parseSubagentMeta("42", 5).agentType).toBeNull();
    // The spawn time came from the file, not its contents, so it survives.
    expect(parseSubagentMeta("[1,2,3]", 5).createdAt).toBe(5);
  });

  it("reads a sidecar the editor left a byte-order mark on", () => {
    const meta = parseSubagentMeta('\uFEFF{"agentType":"general-purpose"}', null);
    expect(meta.agentType).toBe("general-purpose");
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

  it("does not promote a stop reason nobody has seen into a completion", () => {
    // `max_tokens` and `pause_turn` mean the turn was cut short, and an
    // unfamiliar value is not evidence of anything.
    for (const stop of ["max_tokens", "pause_turn", "something_new", ""]) {
      const last = { type: "assistant", message: { stop_reason: stop }, timestamp: null };
      expect(inferStatus(last, now, now).type).not.toBe("completed");
    }
  });

  it("will not read past a half-written line to an older completion", () => {
    const older = { type: "assistant", message: { stop_reason: "end_turn" }, timestamp: null };
    // A child that finished one turn and is streaming the next: the older
    // end_turn is real, it is just not this child's last word any more.
    expect(inferStatus(older, now, now, true)).toEqual({ type: "working" });
    expect(inferStatus(older, now - CLAUDE_SUBAGENT_ACTIVE_WINDOW_MS - 1, now, true)).toEqual({
      type: "unknown",
      reason: "stale",
    });
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

  // Mode bits do not gate reads for Windows or for root, so the setup this
  // needs cannot be arranged there.
  const enforcesModeBits = process.platform !== "win32" && process.getuid?.() !== 0;

  it.skipIf(!enforcesModeBits)(
    "raises a directory it cannot read rather than reporting it as empty",
    async () => {
      const dir = await makeSubagentsDir("/Users/x/Projects/demo");
      await writeChild(dir, "aaa1", [userRecord("go")]);
      await chmod(dir, 0o000);
      try {
        // "No children" and "no permission" are different answers, and only one
        // of them is something we observed.
        await expect(listSubagentsInDir(dir)).rejects.toThrow();
      } finally {
        await chmod(dir, 0o700);
      }
    }
  );

  it("does not report a child as done when its last line is still being written", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [
      userRecord("go"),
      assistantRecord("finished the first turn", "end_turn"),
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tex',
    ]);

    const [child] = await listSubagentsInDir(dir);
    expect(child?.status).toEqual({ type: "working" });
  });

  it("reads a lone record that was never terminated with a newline", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeFile(path.join(dir, "agent-aaa1.jsonl"), userRecord("the only task"), "utf8");

    const [child] = await listSubagentsInDir(dir);
    expect(child?.preview).toBe("the only task");
  });

  it("keeps reading a transcript once it outgrows the probe window", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    // Padding puts the closing record far past the head probe, so status has to
    // come from the tail read rather than from the opening chunk.
    const filler = Array.from({ length: 400 }, (_, index) =>
      assistantRecord(`step ${index} ${"x".repeat(500)}`, "tool_use")
    );
    await writeChild(dir, "aaa1", [
      userRecord("the delegated task"),
      ...filler,
      assistantRecord("all done", "end_turn"),
    ]);

    const [child] = await listSubagentsInDir(dir);
    expect(child?.preview).toBe("the delegated task");
    expect(child?.status).toEqual({ type: "completed" });
  });

  it("skips a transcript name that is a symlink to another session's history", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    const outside = path.join(root, "elsewhere.jsonl");
    await writeFile(outside, userRecord("someone else's work") + "\n", "utf8");
    await symlink(outside, path.join(dir, "agent-aaa1.jsonl"));

    await expect(listSubagentsInDir(dir)).resolves.toEqual([]);
  });

  it("breaks a tie on activity deterministically rather than by directory order", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    const a = await writeChild(dir, "bbb2", [userRecord("second")]);
    const b = await writeChild(dir, "aaa1", [userRecord("first")]);
    const same = new Date(1_700_000_000_000);
    await utimes(a, same, same);
    await utimes(b, same, same);

    expect((await listSubagentsInDir(dir)).map((c) => c.id)).toEqual(["aaa1", "bbb2"]);
  });

  it("survives a record whose message is not an object", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [
      record({ type: "user", message: null }),
      record({ type: "user", message: "a bare string" }),
      '["not","a","record"]',
      assistantRecord("done", "end_turn"),
    ]);

    const [child] = await listSubagentsInDir(dir);
    expect(child?.status).toEqual({ type: "completed" });
    expect(child?.preview).toBe("");
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

  it("calls a child done when the CLI logged bookkeeping after its final turn", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [
      userRecord("go"),
      assistantRecord("all done", "end_turn"),
      record({ type: "attachment", attachment: { type: "hook_success" } }),
      record({ type: "system", subtype: "turn_duration" }),
      record({ type: "file-history-snapshot" }),
    ]);

    const [child] = await listSubagentsInDir(dir);
    expect(child?.status).toEqual({ type: "completed" });
  });

  it("does not let bookkeeping hide a turn that has not ended", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [
      userRecord("go"),
      assistantRecord("interim", "end_turn"),
      userRecord("and the next thing"),
      record({ type: "attachment", attachment: { type: "total_tokens_reminder" } }),
    ]);

    const [child] = await listSubagentsInDir(dir);
    expect(child?.status).toEqual({ type: "working" });
  });

  it("will not step over a half-written line behind trailing bookkeeping", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [
      userRecord("go"),
      assistantRecord("finished the first turn", "end_turn"),
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tex',
      record({ type: "attachment", attachment: { type: "hook_success" } }),
    ]);

    const [child] = await listSubagentsInDir(dir);
    expect(child?.status).toEqual({ type: "unknown", reason: "unrecognized" });
  });

  it("finds the final turn behind bookkeeping in a transcript past the probe window", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    const filler = Array.from({ length: 400 }, (_, index) =>
      assistantRecord(`step ${index} ${"x".repeat(500)}`, "tool_use")
    );
    await writeChild(dir, "aaa1", [
      userRecord("the delegated task"),
      ...filler,
      assistantRecord("all done", "end_turn"),
      record({ type: "attachment", attachment: { type: "hook_success" } }),
      record({ type: "system", subtype: "stop_hook_summary" }),
    ]);

    const [child] = await listSubagentsInDir(dir);
    expect(child?.status).toEqual({ type: "completed" });
  });

  it("admits it cannot tell when the tail holds nothing but bookkeeping", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [
      record({ type: "attachment", attachment: { type: "hook_success" } }),
      record({ type: "system", subtype: "turn_duration" }),
    ]);

    const [child] = await listSubagentsInDir(dir);
    expect(child?.status).toEqual({ type: "unknown", reason: "unrecognized" });
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

describe("listSubagentsInDir past what it shows", () => {
  const enforcesModeBits = process.platform !== "win32" && process.getuid?.() !== 0;
  const BASE_SECONDS = 1_700_000_000;

  /** Children `c0000`…, each a second newer than the last, so the highest index leads. */
  async function writeChildren(dir: string, count: number): Promise<string[]> {
    const files: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = `c${String(index).padStart(4, "0")}`;
      const file = await writeChild(
        dir,
        id,
        [userRecord(`task ${index}`), assistantRecord("done", "end_turn")],
        { description: `child ${index}` }
      );
      const at = new Date((BASE_SECONDS + index) * 1000);
      await utimes(file, at, at);
      files.push(file);
    }
    return files;
  }

  it("probes and reads sidecars only for the rows it returns", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChildren(dir, SUBAGENT_LIST_LIMIT + 10);

    const rows = await listSubagentsInDir(dir);
    expect(rows).toHaveLength(SUBAGENT_LIST_LIMIT);
    expect(rows[0]?.id).toBe(`c${String(SUBAGENT_LIST_LIMIT + 9).padStart(4, "0")}`);
    expect(rows.at(-1)?.id).toBe("c0010");
    // The ten oldest were ranked by their `lstat` and never opened.
    expect(opensOf(".jsonl")).toBe(SUBAGENT_LIST_LIMIT);
    expect(opensOf(".meta.json")).toBe(SUBAGENT_LIST_LIMIT);
    const stats = __claudeSubagentCacheStats();
    expect(stats.probes.entries).toBe(SUBAGENT_LIST_LIMIT);
    expect(stats.sidecars.entries).toBe(SUBAGENT_LIST_LIMIT);

    // Nothing changed on disk, so the next poll opens nothing at all.
    opened.paths.length = 0;
    expect(await listSubagentsInDir(dir)).toEqual(rows);
    expect(opened.paths).toEqual([]);
  });

  it.skipIf(!enforcesModeBits)(
    "lets the next child in when a newer one turns out to be unreadable",
    async () => {
      const dir = await makeSubagentsDir("/Users/x/Projects/demo");
      const files = await writeChildren(dir, SUBAGENT_LIST_LIMIT + 1);
      const newest = files.at(-1) as string;
      expect((await listSubagentsInDir(dir)).map((row) => row.id)).not.toContain("c0000");

      await chmod(newest, 0o000);
      try {
        const ids = (await listSubagentsInDir(dir)).map((row) => row.id);
        expect(ids).toHaveLength(SUBAGENT_LIST_LIMIT);
        expect(ids).not.toContain(`c${String(SUBAGENT_LIST_LIMIT).padStart(4, "0")}`);
        expect(ids.at(-1)).toBe("c0000");
      } finally {
        await chmod(newest, 0o600);
      }
    }
  );

  it("keeps an unrecognisable newest transcript as a row rather than refilling past it", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    const files = await writeChildren(dir, SUBAGENT_LIST_LIMIT + 1);
    // Bookkeeping alone: it parses, but there is no task and no turn to read.
    await writeFile(
      files.at(-1) as string,
      record({ type: "summary", summary: "x" }) + "\n",
      "utf8"
    );
    const at = new Date((BASE_SECONDS + SUBAGENT_LIST_LIMIT) * 1000);
    await utimes(files.at(-1) as string, at, at);

    const rows = await listSubagentsInDir(dir);
    expect(rows).toHaveLength(SUBAGENT_LIST_LIMIT);
    expect(rows[0]?.status).toEqual({ type: "unknown", reason: "unrecognized" });
    expect(rows[0]?.preview).toBe("");
    expect(rows.map((row) => row.id)).not.toContain("c0000");
  });

  it("picks up a sidecar that arrives after its transcript was listed", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [userRecord("go")]);
    expect((await listSubagentsInDir(dir))[0]?.label).toBeNull();

    await writeFile(
      path.join(dir, "agent-aaa1.meta.json"),
      JSON.stringify({ description: "Late" })
    );
    expect((await listSubagentsInDir(dir))[0]?.label).toBe("Late");
  });

  it("re-reads a sidecar replaced under the same size and times", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [userRecord("go")]);
    const meta = path.join(dir, "agent-aaa1.meta.json");
    const at = new Date(BASE_SECONDS * 1000);
    await writeFile(meta, JSON.stringify({ description: "aaaa" }));
    await utimes(meta, at, at);
    expect((await listSubagentsInDir(dir))[0]?.label).toBe("aaaa");

    const staged = path.join(dir, "staged.tmp");
    await writeFile(staged, JSON.stringify({ description: "bbbb" }));
    await utimes(staged, at, at);
    await rename(staged, meta);
    expect((await listSubagentsInDir(dir))[0]?.label).toBe("bbbb");
  });

  it("re-reads a sidecar rewritten in place under the same size and mtime", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [userRecord("go")]);
    const meta = path.join(dir, "agent-aaa1.meta.json");
    const at = new Date(BASE_SECONDS * 1000);
    await writeFile(meta, JSON.stringify({ description: "aaaa" }));
    await utimes(meta, at, at);
    const before = await lstat(meta);
    expect((await listSubagentsInDir(dir))[0]?.label).toBe("aaaa");

    // Same inode, size and mtime: only the ctime can tell. A coarse ctime
    // clock can put both writes in one tick, so touch until it moves.
    await writeFile(meta, JSON.stringify({ description: "bbbb" }));
    let after = before;
    for (let attempt = 0; attempt < 200 && after.ctimeMs === before.ctimeMs; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await utimes(meta, at, at);
      after = await lstat(meta);
    }
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);
    expect((await listSubagentsInDir(dir))[0]?.label).toBe("bbbb");
  });

  it("stops trusting a sidecar that has been swapped for a symlink", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    await writeChild(dir, "aaa1", [userRecord("go")], { description: "Real" });
    expect((await listSubagentsInDir(dir))[0]?.label).toBe("Real");

    const planted = path.join(root, "planted.meta.json");
    await writeFile(planted, JSON.stringify({ description: "Planted" }));
    const meta = path.join(dir, "agent-aaa1.meta.json");
    await rm(meta);
    await symlink(planted, meta);
    const [child] = await listSubagentsInDir(dir);
    expect(child?.label).toBeNull();
    expect(child?.createdAt).toBe(Date.parse("2026-08-01T19:28:19.515Z"));
  });

  it("derives status from the clock on every call, even from a cached probe", async () => {
    const dir = await makeSubagentsDir("/Users/x/Projects/demo");
    const file = await writeChild(dir, "aaa1", [
      userRecord("go"),
      assistantRecord("thinking", "tool_use"),
    ]);
    const at = BASE_SECONDS * 1000;
    await utimes(file, new Date(at), new Date(at));

    const fresh = await listSubagentsInDir(dir, { now: () => at + 1_000 });
    expect(fresh[0]?.status).toEqual({ type: "working" });
    opened.paths.length = 0;
    const later = await listSubagentsInDir(dir, {
      now: () => at + CLAUDE_SUBAGENT_ACTIVE_WINDOW_MS + 1,
    });
    expect(later[0]?.status).toEqual({ type: "unknown", reason: "stale" });
    expect(opensOf(".jsonl")).toBe(0);
  });
});

describe("WarmCache", () => {
  const HOUR = 3_600_000;

  it("keeps hitting on what it holds when polled in a loop larger than itself", () => {
    const cache = new WarmCache<number>(4, 1_000_000);
    const keys = ["a", "b", "c", "d", "e", "f"];
    let now = 0;
    const poll = (): number => {
      let hits = 0;
      for (const key of keys) {
        if (cache.get(key, "v1", now) !== undefined) hits += 1;
        else cache.set(key, "v1", 1, 10, now);
      }
      now += 5_000;
      return hits;
    };

    poll();
    // FIFO or LRU would hit nothing here: each insert evicts the next key needed.
    expect(poll()).toBe(4);
    expect(poll()).toBe(4);
    expect(cache.stats()).toEqual({ entries: 4, bytes: 40 });
  });

  it("makes room by dropping what has gone unused", () => {
    const cache = new WarmCache<string>(2, 1_000_000);
    cache.set("a", "v1", "a", 10, 0);
    cache.set("b", "v1", "b", 10, 1);
    cache.set("c", "v1", "c", 10, 2);
    expect(cache.get("c", "v1", 2)).toBeUndefined();

    cache.set("c", "v1", "c", 10, HOUR);
    expect(cache.get("a", "v1", HOUR)).toBeUndefined();
    expect(cache.get("b", "v1", HOUR)).toBe("b");
    expect(cache.get("c", "v1", HOUR)).toBe("c");
  });

  it("renews an entry each time it is used, and evicts in order of last use", () => {
    const cache = new WarmCache<string>(2, 1_000_000);
    cache.set("a", "v1", "a", 10, 0);
    cache.set("b", "v1", "b", 10, 1);
    expect(cache.get("a", "v1", 20_000)).toBe("a");

    // `b` was last used at 1 ms, so it is cold and goes first; `a` was renewed.
    cache.set("c", "v1", "c", 10, 35_000);
    expect(cache.get("b", "v1", 35_000)).toBeUndefined();

    // Ten seconds later `a` is still inside its renewed warm window.
    cache.set("d", "v1", "d", 10, 45_000);
    expect(cache.get("d", "v1", 45_000)).toBeUndefined();
    expect(cache.get("a", "v1", 45_000)).toBe("a");
    expect(cache.get("c", "v1", 45_000)).toBe("c");
  });

  it("keeps its byte count exact across replacement and refusal", () => {
    const cache = new WarmCache<string>(2, 100);
    cache.set("a", "v1", "a", 30, 0);
    cache.set("a", "v2", "a2", 50, 0);
    expect(cache.stats()).toEqual({ entries: 1, bytes: 50 });

    cache.set("b", "v1", "b", 60, 0);
    cache.set("big", "v1", "big", 101, 0);
    expect(cache.stats()).toEqual({ entries: 1, bytes: 50 });

    expect(cache.get("a", "v1", 0)).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("never holds more bytes than its cap", () => {
    const cache = new WarmCache<string>(10, 100);
    cache.set("a", "v1", "a", 60, 0);
    cache.set("b", "v1", "b", 60, 0);
    cache.set("huge", "v1", "huge", 200, HOUR);
    expect(cache.stats()).toEqual({ entries: 1, bytes: 60 });

    cache.set("b", "v1", "b", 60, HOUR);
    expect(cache.stats()).toEqual({ entries: 1, bytes: 60 });
    expect(cache.get("b", "v1", HOUR)).toBe("b");
  });

  it("drops an entry once the file behind it has a different identity", () => {
    const cache = new WarmCache<string>(4, 1_000);
    cache.set("a", "v1", "old", 10, 0);
    expect(cache.get("a", "v2", 0)).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
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
