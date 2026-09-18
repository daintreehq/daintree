import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

// Hooks in front of `lstat` and `open`, so a test can change the filesystem at
// an exact point in the reader's sequence instead of racing it.
const fsHook = vi.hoisted(() => ({
  beforeLstat: null as null | ((target: string) => Promise<void>),
  beforeOpen: null as null | ((target: string) => Promise<void>),
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    lstat: async (target: string) => {
      await fsHook.beforeLstat?.(target);
      return actual.lstat(target);
    },
    open: async (target: string, flags?: string | number, mode?: number) => {
      await fsHook.beforeOpen?.(target);
      return actual.open(target, flags, mode);
    },
  };
});
import {
  fitWithinResponseCap,
  readClaudeLastMessage,
  tailWithinJsonBytes,
} from "../ClaudeSessionReader.js";
import { deriveProjectSlug } from "../ClaudeSubagentReader.js";
import {
  LAST_MESSAGE_TEXT_MAX_BYTES,
  LAST_MESSAGE_TOOL_USE_LIMIT,
  type AgentLastMessageOk,
  type AgentLastMessageResult,
} from "../../../../shared/types/agentLastMessage.js";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../../shared/config/mcpLimits.js";

const SESSION = "1ad2578c-b710-4302-90c1-b222c4c29aa2";
const CWD = "/Users/x/Projects/demo";
const STAMP = "2026-09-18T10:00:00.000Z";

let root: string;
let projectsRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "claude-session-reader-"));
  projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot);
});

afterEach(async () => {
  fsHook.beforeLstat = null;
  fsHook.beforeOpen = null;
  await rm(root, { recursive: true, force: true });
});

const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: "tool_use",
  id,
  name,
  input,
});

function assistant(
  id: string | null,
  blocks: unknown[],
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { id, role: "assistant", content: blocks, stop_reason: "end_turn" },
    timestamp: STAMP,
    ...extra,
  });
}

function toolResult(id: string, content: unknown = "ok"): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
    timestamp: STAMP,
  });
}

function prompt(value: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: value },
    timestamp: STAMP,
    ...extra,
  });
}

const system = (subtype: string) => JSON.stringify({ type: "system", subtype, timestamp: STAMP });

async function seed(
  lines: string[],
  options: { slug?: string; trailing?: string } = {}
): Promise<string> {
  const dir = path.join(projectsRoot, options.slug ?? deriveProjectSlug(CWD));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${SESSION}.jsonl`);
  await writeFile(file, lines.join("\n") + "\n" + (options.trailing ?? ""), "utf8");
  return file;
}

function read(options: Parameters<typeof readClaudeLastMessage>[1] = {}) {
  return readClaudeLastMessage({ projectsRoot, cwd: CWD, sessionId: SESSION }, options);
}

function ok(result: AgentLastMessageResult): AgentLastMessageOk {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.reason}`);
  return result;
}

describe("readClaudeLastMessage — which message", () => {
  it("joins the text blocks of the records that share the last message id, in order", async () => {
    await seed([
      prompt("do the thing"),
      assistant("msg_1", [thinking("hmm")]),
      assistant("msg_1", [text("First paragraph.")]),
      assistant("msg_1", [text("Second paragraph.")]),
    ]);

    const result = ok(await read());

    expect(result.provider).toBe("claude");
    expect(result.message).toMatchObject({
      id: "msg_1",
      text: "First paragraph.\n\nSecond paragraph.",
      truncated: false,
      stopReason: "end_turn",
      recordedAt: Date.parse(STAMP),
    });
    expect(result.newerRecordsFollow).toBe(false);
  });

  // Prose, then tools, then a hand-off is three messages. Coalescing the turn
  // would put an intention the agent moved past in front of its answer.
  it("returns only the last message with text, not the whole turn", async () => {
    await seed([
      prompt("review it"),
      assistant("msg_1", [text("I'll start by reading the diff.")]),
      assistant("msg_1", [toolUse("toolu_1", "Read")]),
      toolResult("toolu_1"),
      assistant("msg_2", [text("Verdict: ship it.")]),
    ]);

    const result = ok(await read());

    expect(result.message?.text).toBe("Verdict: ship it.");
    expect(result.unansweredToolUses).toEqual([]);
  });

  it("steps over the records Claude Code writes after a reply", async () => {
    await seed([
      prompt("go"),
      assistant("msg_1", [text("Done.")]),
      system("stop_hook_summary"),
      system("turn_duration"),
      JSON.stringify({ type: "last-prompt", lastPrompt: "go" }),
      JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
    ]);

    const result = ok(await read());

    expect(result.message?.text).toBe("Done.");
    expect(result.newerRecordsFollow).toBe(false);
  });

  it("finds the last reply behind a compaction and never returns the summary", async () => {
    await seed([
      prompt("go"),
      assistant("msg_1", [text("Before compaction.")]),
      system("compact_boundary"),
      prompt("This session is being continued from a previous conversation…", {
        isCompactSummary: true,
      }),
    ]);

    const result = ok(await read());

    expect(result.message?.text).toBe("Before compaction.");
    expect(result.newerRecordsFollow).toBe(false);
  });

  it("stops gathering a message's records at a compaction boundary", async () => {
    await seed([
      assistant("msg_1", [text("Old half.")]),
      system("compact_boundary"),
      assistant("msg_1", [text("New half.")]),
    ]);

    expect(ok(await read()).message?.text).toBe("New half.");
  });

  it("ignores sidechain records entirely", async () => {
    await seed([
      assistant("msg_1", [text("Main chain reply.")]),
      assistant("msg_side", [text("A subagent's reply.")], { isSidechain: true }),
      assistant("msg_side", [toolUse("toolu_side", "AskUserQuestion")], { isSidechain: true }),
    ]);

    const result = ok(await read());

    expect(result.message?.text).toBe("Main chain reply.");
    expect(result.unansweredToolUses).toEqual([]);
    expect(result.newerRecordsFollow).toBe(false);
  });

  it("treats a record with no message id as a message of its own", async () => {
    await seed([assistant("msg_1", [text("Earlier.")]), assistant(null, [text("No id.")])]);

    const result = ok(await read());

    expect(result.message).toMatchObject({ id: null, text: "No id." });
  });

  it("reports the stop reason raw, including null", async () => {
    await seed([
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_1", content: [text("mid-turn")], stop_reason: null },
      }),
    ]);

    const result = ok(await read());

    expect(result.message).toMatchObject({ stopReason: null, recordedAt: null });
  });

  it("says newer conversation follows when a prompt came after the reply", async () => {
    await seed([assistant("msg_1", [text("Done.")]), prompt("now do more")]);

    const result = ok(await read());

    expect(result.message?.text).toBe("Done.");
    expect(result.newerRecordsFollow).toBe(true);
  });

  // A result and something the user typed can share one record. The result
  // answers the call; the text is still a new prompt.
  it("treats a record carrying a tool result and typed text as a new prompt", async () => {
    await seed([
      assistant("msg_1", [text("Ready.")]),
      assistant("msg_1", [toolUse("toolu_r", "Read")]),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_r", content: "ok" },
            { type: "text", text: "Actually, stop." },
          ],
        },
      }),
    ]);

    const result = ok(await read());

    expect(result.message?.text).toBe("Ready.");
    expect(result.unansweredToolUses).toEqual([]);
    expect(result.newerRecordsFollow).toBe(true);
  });

  it("stops gathering a message at a prompt that also carries a result", async () => {
    await seed([
      assistant("msg_1", [text("Before the prompt.")]),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_x", content: "ok" },
            { type: "text", text: "and another thing" },
          ],
        },
      }),
      assistant("msg_1", [text("After it.")]),
    ]);

    expect(ok(await read()).message?.text).toBe("After it.");
  });

  it("says newer conversation follows once a tool the reply called has run", async () => {
    await seed([
      assistant("msg_1", [text("Running the suite.")]),
      assistant("msg_1", [toolUse("toolu_t", "Bash", { command: "npm test" })]),
      toolResult("toolu_t", "passed"),
    ]);

    const result = ok(await read());

    expect(result.message?.text).toBe("Running the suite.");
    expect(result.newerRecordsFollow).toBe(true);
  });

  // A slash command is input the user sent after the reply, whatever it did —
  // telling `/exit` from a skill invocation would mean guessing at intent the
  // record does not carry. Its caveat line is marked meta and counts for nothing.
  it("counts a slash command typed after the reply as newer, and keeps the reply", async () => {
    await seed([
      assistant("msg_1", [text("Done.")]),
      prompt("<local-command-caveat>Caveat: generated by local commands</local-command-caveat>", {
        isMeta: true,
      }),
      prompt("<command-name>/exit</command-name>\n<command-message>exit</command-message>"),
      prompt("<local-command-stdout>Goodbye!</local-command-stdout>"),
    ]);

    const result = ok(await read());

    expect(result.message?.text).toBe("Done.");
    expect(result.newerRecordsFollow).toBe(true);
  });

  it("never takes an assistant record marked meta for the reply", async () => {
    await seed([
      assistant("msg_1", [text("The real reply.")]),
      assistant("msg_2", [text("Harness-injected.")], { isMeta: true }),
    ]);

    const result = ok(await read());

    expect(result.message?.text).toBe("The real reply.");
    expect(result.newerRecordsFollow).toBe(false);
  });

  it("says newer conversation follows when the agent went on to another message", async () => {
    await seed([
      assistant("msg_1", [text("Starting.")]),
      assistant("msg_2", [toolUse("toolu_1", "Bash", { command: "npm test" })]),
    ]);

    const result = ok(await read());

    expect(result.message?.text).toBe("Starting.");
    expect(result.newerRecordsFollow).toBe(true);
    expect(result.unansweredToolUses).toEqual([{ id: "toolu_1", name: "Bash" }]);
  });
});

describe("readClaudeLastMessage — unanswered tool uses", () => {
  const QUESTION = {
    questions: [
      {
        question: "Which database?",
        header: "Database",
        options: [
          { label: "Postgres", description: "Relational" },
          { label: "SQLite", description: "Embedded" },
        ],
        multiSelect: false,
      },
    ],
  };

  // The case that makes the tool worth having: the question is a tool call,
  // never text, and often comes with no prose at all.
  it("returns a question with no prose before it, with its input", async () => {
    await seed([
      prompt("set it up"),
      assistant("msg_1", [toolUse("toolu_q", "AskUserQuestion", QUESTION)]),
    ]);

    const result = ok(await read());

    expect(result.message).toBeNull();
    expect(result.unansweredToolUses).toEqual([
      { id: "toolu_q", name: "AskUserQuestion", input: QUESTION },
    ]);
  });

  it("returns the prose and the question that closes the same message", async () => {
    await seed([
      prompt("set it up"),
      assistant("msg_1", [text("Before I start, one decision.")]),
      assistant("msg_1", [toolUse("toolu_q", "AskUserQuestion", QUESTION)]),
    ]);

    const result = ok(await read());

    expect(result.message?.text).toBe("Before I start, one decision.");
    expect(result.unansweredToolUses).toEqual([
      { id: "toolu_q", name: "AskUserQuestion", input: QUESTION },
    ]);
    // The question is part of the message, not something after it.
    expect(result.newerRecordsFollow).toBe(false);
  });

  it("drops a question once a result for it is on record", async () => {
    await seed([
      assistant("msg_1", [text("One decision first.")]),
      assistant("msg_1", [toolUse("toolu_q", "AskUserQuestion", QUESTION)]),
      toolResult("toolu_q", "Postgres"),
    ]);

    const result = ok(await read());

    expect(result.message?.text).toBe("One decision first.");
    expect(result.unansweredToolUses).toEqual([]);
    // The answer is newer than the prose it follows.
    expect(result.newerRecordsFollow).toBe(true);
  });

  it("matches results by id, not by tool name", async () => {
    await seed([
      assistant("msg_1", [text("Reading two files.")]),
      assistant("msg_1", [toolUse("toolu_a", "Read", { file_path: "/a" })]),
      assistant("msg_1", [toolUse("toolu_b", "Read", { file_path: "/b" })]),
      toolResult("toolu_a"),
    ]);

    expect(ok(await read()).unansweredToolUses).toEqual([{ id: "toolu_b", name: "Read" }]);
  });

  // Tool input is where file contents live.
  it("returns only the name for any tool other than a question", async () => {
    await seed([
      assistant("msg_1", [toolUse("toolu_w", "Write", { content: "SECRET FILE BODY" })]),
    ]);

    const result = ok(await read());

    expect(result.unansweredToolUses).toEqual([{ id: "toolu_w", name: "Write" }]);
    expect(JSON.stringify(result)).not.toContain("SECRET FILE BODY");
  });

  it("omits a question's input whole when it is too large, rather than cutting it", async () => {
    const huge = { questions: [{ question: "x".repeat(9 * 1024), options: [] }] };
    await seed([assistant("msg_1", [toolUse("toolu_q", "AskUserQuestion", huge)])]);

    expect(ok(await read()).unansweredToolUses).toEqual([
      { id: "toolu_q", name: "AskUserQuestion" },
    ]);
  });

  // Well under both byte caps, but past the reader's own nesting limit, which
  // keeps clear of the depth at which the transport drops a whole structured
  // result.
  it("omits a question's input when it nests too deeply to return", async () => {
    let nested: Record<string, unknown> = { question: "deep" };
    for (let i = 0; i < 40; i++) nested = { x: nested };
    await seed([assistant("msg_1", [toolUse("toolu_q", "AskUserQuestion", nested)])]);

    expect(ok(await read()).unansweredToolUses).toEqual([
      { id: "toolu_q", name: "AskUserQuestion" },
    ]);
  });

  it("keeps the calls of one record in the order they were made", async () => {
    const count = LAST_MESSAGE_TOOL_USE_LIMIT + 1;
    await seed([
      assistant(
        "msg_1",
        Array.from({ length: count }, (_, i) => toolUse(`toolu_${i}`, "Bash"))
      ),
    ]);

    const ids = ok(await read()).unansweredToolUses.map((use) => use.id);

    expect(ids).toEqual(
      Array.from({ length: LAST_MESSAGE_TOOL_USE_LIMIT }, (_, i) => `toolu_${i + 1}`)
    );
  });

  it("keeps the newest tool uses, oldest first, up to the limit", async () => {
    const count = LAST_MESSAGE_TOOL_USE_LIMIT + 3;
    await seed(
      Array.from({ length: count }, (_, i) =>
        assistant(`msg_${i}`, [toolUse(`toolu_${i}`, "Bash")])
      )
    );

    const ids = ok(await read()).unansweredToolUses.map((use) => use.id);

    expect(ids).toEqual(
      Array.from({ length: LAST_MESSAGE_TOOL_USE_LIMIT }, (_, i) => `toolu_${i + 3}`)
    );
  });
});

describe("readClaudeLastMessage — reading from the end", () => {
  it("skips a final line that is still being written", async () => {
    await seed([assistant("msg_1", [text("Whole reply.")])], {
      trailing: '{"type":"assistant","message":{"id":"msg_2","content":[{"type":"te',
    });

    const result = ok(await read());

    expect(result.message?.text).toBe("Whole reply.");
    expect(result.newerRecordsFollow).toBe(true);
  });

  it("finds nothing in a file that is one unterminated line", async () => {
    const dir = path.join(projectsRoot, deriveProjectSlug(CWD));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${SESSION}.jsonl`), assistant("msg_1", [text("partial")]));

    expect(await read()).toEqual({ status: "unavailable", reason: "no-message" });
  });

  // One tool result can carry a whole file on a single line. Reaching past it
  // for an older reply would hand that reply back as current.
  it("reports the cap rather than an older reply when a huge line hides the latest one", async () => {
    await seed([assistant("msg_1", [text("Old reply.")]), toolResult("toolu_1", "x".repeat(4096))]);

    expect(await read({ chunkBytes: 512, maxScanBytes: 2048 })).toEqual({
      status: "unavailable",
      reason: "search-cap-reached",
    });
  });

  it("marks a reply truncated when its first records lie beyond the cap", async () => {
    await seed([
      assistant("msg_1", [text("a".repeat(3000))]),
      assistant("msg_1", [text("The end.")]),
    ]);

    const result = ok(await read({ chunkBytes: 256, maxScanBytes: 1024 }));

    expect(result.message).toMatchObject({ text: "The end.", truncated: true });
  });

  it("reassembles lines and characters split across reads", async () => {
    const reply = "Résumé ✓ — 日本語のテキスト 🚀🚀 done";
    await seed([
      prompt("go"),
      assistant("msg_1", [text("earlier 🚀")]),
      toolResult("toolu_x", "é".repeat(50)),
      assistant("msg_2", [text(reply)]),
      system("turn_duration"),
    ]);

    for (const chunkBytes of [1, 3, 7, 64]) {
      const result = ok(await read({ chunkBytes }));
      expect(result.message?.text).toBe(reply);
    }
  });

  it("tolerates lines that are not JSON records", async () => {
    await seed([assistant("msg_1", [text("Reply.")]), "not json", "[1,2,3]", "   "]);

    expect(ok(await read()).message?.text).toBe("Reply.");
  });

  it("keeps the end of a long message and says it was cut", async () => {
    const body = "x".repeat(LAST_MESSAGE_TEXT_MAX_BYTES) + "THE END";
    await seed([assistant("msg_1", [text(body)])]);

    const message = ok(await read()).message;

    expect(message?.truncated).toBe(true);
    expect(message?.text.endsWith("THE END")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(message?.text)) - 2).toBeLessThanOrEqual(
      LAST_MESSAGE_TEXT_MAX_BYTES
    );
  });

  it("stays inside the response cap even when every character escapes to six bytes", async () => {
    const question = { questions: [{ question: "".repeat(1200) }] };
    await seed([
      assistant("msg_1", [text("".repeat(60 * 1024))]),
      ...Array.from({ length: 4 }, (_, i) =>
        assistant("msg_1", [toolUse(`toolu_${i}`, "AskUserQuestion", question)])
      ),
    ]);

    const result = ok(await read());

    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      MCP_RESPONSE_TEXT_MAX_BYTES
    );
    expect(result.message?.truncated).toBe(true);
  });

  it("stops when the call is cancelled", async () => {
    await seed([assistant("msg_1", [text("Reply.")])]);
    const controller = new AbortController();
    controller.abort();

    await expect(read({ signal: controller.signal })).rejects.toThrow();
  });
});

describe("readClaudeLastMessage — which file", () => {
  it("reports nothing on record when the session has no transcript yet", async () => {
    expect(await read()).toEqual({ status: "unavailable", reason: "no-message" });
  });

  it("reports nothing on record when the store itself is absent", async () => {
    await rm(projectsRoot, { recursive: true });

    expect(await read()).toEqual({ status: "unavailable", reason: "no-message" });
  });

  it("finds the transcript by session id when the cwd slug does not match", async () => {
    await seed([assistant("msg_1", [text("Found anyway.")])], { slug: "-some-other-folder" });

    expect(ok(await read()).message?.text).toBe("Found anyway.");
  });

  it("refuses a session id that could steer the path", async () => {
    const result = await readClaudeLastMessage({
      projectsRoot,
      cwd: CWD,
      sessionId: "../../etc/passwd",
    });

    expect(result).toEqual({ status: "unavailable", reason: "no-session" });
  });

  // `stat` would follow the link to whatever it names — another session's
  // transcript, or any file at all.
  it("refuses a transcript that is a symlink", async () => {
    const elsewhere = path.join(root, "elsewhere.jsonl");
    await writeFile(elsewhere, assistant("msg_1", [text("Not this session's.")]) + "\n");
    const dir = path.join(projectsRoot, deriveProjectSlug(CWD));
    await mkdir(dir, { recursive: true });
    await symlink(elsewhere, path.join(dir, `${SESSION}.jsonl`));

    expect(await read()).toEqual({ status: "unavailable", reason: "store-unreadable" });
  });

  it("does not follow a project directory that points outside the store", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(
      path.join(outside, `${SESSION}.jsonl`),
      assistant("msg_1", [text("Outside.")]) + "\n"
    );
    await symlink(outside, path.join(projectsRoot, deriveProjectSlug(CWD)));

    expect(await read()).toEqual({ status: "unavailable", reason: "no-message" });
  });

  // `O_NOFOLLOW` guards the last path component only. A project directory
  // swapped for a link to somewhere else after the containment check would
  // otherwise carry the open outside the store with every check still green.
  it("refuses a file reached through a directory swapped out after the containment check", async () => {
    const file = await seed([assistant("msg_1", [text("Inside the store.")])]);
    const dir = path.dirname(file);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(
      path.join(outside, `${SESSION}.jsonl`),
      assistant("msg_1", [text("Outside the store.")]) + "\n"
    );
    // The first `lstat` of the file finds it; the second is the open's own
    // check, after the directory has already been judged contained.
    let lstatsOfFile = 0;
    fsHook.beforeLstat = async (target) => {
      if (target !== file || ++lstatsOfFile !== 2) return;
      await rename(dir, `${dir}-moved`);
      await symlink(outside, dir);
    };

    expect(await read()).toEqual({ status: "unavailable", reason: "store-unreadable" });
    expect(lstatsOfFile).toBe(2);
  });

  // A read-only open of a FIFO waits for a writer. Without a non-blocking open
  // a leaf swapped for one after the check would hold the read forever, past
  // any cancellation.
  it.skipIf(process.platform === "win32")(
    "refuses a transcript swapped for a FIFO after the check, without blocking",
    async () => {
      const file = await seed([assistant("msg_1", [text("Reply.")])]);
      fsHook.beforeOpen = async (target) => {
        if (target !== file) return;
        await rm(file);
        execFileSync("mkfifo", [file]);
      };

      expect(await read()).toEqual({ status: "unavailable", reason: "store-unreadable" });
    }
  );

  it("reads through a store whose root is itself a symlink", async () => {
    await seed([assistant("msg_1", [text("Via the link.")])]);
    const linked = path.join(root, "linked-projects");
    await symlink(projectsRoot, linked);

    const result = await readClaudeLastMessage({
      projectsRoot: linked,
      cwd: CWD,
      sessionId: SESSION,
    });

    expect(ok(result).message?.text).toBe("Via the link.");
  });

  it("reports the file's modification time", async () => {
    await seed([assistant("msg_1", [text("Reply.")])]);

    const result = ok(await read());

    expect(result.fileUpdatedAt).toBeGreaterThan(0);
  });
});

describe("tailWithinJsonBytes", () => {
  it("keeps the whole text when it fits", () => {
    expect(tailWithinJsonBytes("hello", 5)).toEqual({ text: "hello", truncated: false });
  });

  it("counts a control character at its escaped size", () => {
    expect(tailWithinJsonBytes("ab", 6)).toEqual({ text: "", truncated: true });
    expect(tailWithinJsonBytes("ab\n", 3)).toEqual({ text: "b\n", truncated: true });
  });

  it("never splits a surrogate pair", () => {
    expect(tailWithinJsonBytes("a🚀", 3)).toEqual({ text: "", truncated: true });
    expect(tailWithinJsonBytes("a🚀", 4)).toEqual({ text: "🚀", truncated: true });
  });
});

describe("fitWithinResponseCap", () => {
  const base: AgentLastMessageOk = {
    status: "ok",
    provider: "claude",
    message: { id: "m", text: "x".repeat(200), truncated: false, recordedAt: 1, stopReason: null },
    unansweredToolUses: [{ id: "t", name: "AskUserQuestion", input: { q: "y".repeat(200) } }],
    newerRecordsFollow: false,
    fileUpdatedAt: 1,
  };

  it("leaves a result that fits untouched", () => {
    expect(fitWithinResponseCap(base, 10_000)).toBe(base);
  });

  it("gives up question inputs before any text", () => {
    const size = Buffer.byteLength(JSON.stringify(base));
    const fitted = fitWithinResponseCap(base, size - 100);

    expect(fitted.unansweredToolUses).toEqual([{ id: "t", name: "AskUserQuestion" }]);
    expect(fitted.message?.text).toBe(base.message?.text);
  });

  it("then cuts the head of the text to fit", () => {
    const fitted = fitWithinResponseCap(base, 300);

    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(300);
    expect(fitted.message?.truncated).toBe(true);
  });
});
