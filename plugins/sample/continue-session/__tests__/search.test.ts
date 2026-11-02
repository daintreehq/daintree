import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversionRecord } from "../main/catalog.js";
import { convertSession, SessionMismatchError } from "../main/convert.js";
import type { Catalog } from "../main/catalog.js";
import { chunks, IndexStore, type SearchHit } from "../main/indexStore.js";
import { buildMatch, canSearch, createSearchTool, RESULT_BUDGET_BYTES } from "../main/search.js";
import {
  claudeTranscript,
  CLAUDE_SESSION_ID,
  codexRollout,
  CODEX_SESSION_ID,
  tempDir,
  writeJsonl,
} from "./fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { dir: string; store: IndexStore } {
  const dir = tempDir("index");
  dirs.push(dir);
  return { dir, store: new IndexStore(join(dir, "sessions")) };
}

const neverAborted = new AbortController().signal;

describe("buildMatch", () => {
  it("quotes every word, so FTS5 operators and stray quotes are just text", () => {
    expect(buildMatch('voice NEAR(cmd) OR x* "unbalanced', "all")).toBe(
      '"voice" AND "NEAR cmd" AND "OR" AND "x" AND "unbalanced"'
    );
  });

  it("keeps an identifier the tokenizer would split as one phrase", () => {
    expect(buildMatch("VOICE_KEY src/keys.ts", "any")).toBe('"VOICE KEY" OR "src keys ts"');
  });

  it("keeps a quoted phrase as a phrase and joins with OR for an any-word search", () => {
    expect(buildMatch('"shared windows replacement" keymap', "any")).toBe(
      '"shared windows replacement" OR "keymap"'
    );
  });

  it("has nothing to match when the query has no words", () => {
    expect(buildMatch("*** ::: ()", "all")).toBeNull();
  });
});

describe("canSearch", () => {
  const record = { projectId: "p1", terminalIds: ["t-continue"] } as unknown as ConversionRecord;

  it("lets the continuing agent search its session", () => {
    expect(canSearch(record, { projectId: "p1", terminalId: "t-continue" }, new Set())).toBe(true);
  });

  it("refuses another terminal, and the same terminal id in another project", () => {
    expect(canSearch(record, { projectId: "p1", terminalId: "t-other" }, new Set())).toBe(false);
    expect(canSearch(record, { projectId: "p2", terminalId: "t-continue" }, new Set())).toBe(false);
  });

  it("refuses everyone while the continuing agent hasn't been launched", () => {
    const pending = { ...record, terminalIds: [] };
    expect(canSearch(pending, { projectId: "p1", terminalId: "t-continue" }, new Set())).toBe(
      false
    );
  });

  it("opens a shared project's sessions to its agents and to other sharing projects only", () => {
    expect(canSearch(record, { projectId: "p1", terminalId: "t-other" }, new Set(["p1"]))).toBe(
      true
    );
    expect(canSearch(record, { projectId: "p2", terminalId: "t" }, new Set(["p1", "p2"]))).toBe(
      true
    );
    // p2 sharing doesn't open p1's sessions, and p1 sharing doesn't reach a project that doesn't.
    expect(canSearch(record, { projectId: "p2", terminalId: "t" }, new Set(["p2"]))).toBe(false);
    expect(canSearch(record, { projectId: "p2", terminalId: "t" }, new Set(["p1"]))).toBe(false);
  });
});

describe("convertSession and IndexStore", () => {
  it("indexes a Codex rollout and finds records by their words, with their line and byte offset", async () => {
    const { dir, store } = workspace();
    const source = join(dir, "rollout.jsonl");
    const records = codexRollout();
    writeJsonl(source, records);

    const result = await convertSession(store, {
      id: "c1",
      agentId: "codex",
      sessionId: CODEX_SESSION_ID,
      path: source,
      signal: neverAborted,
      onProgress: () => {},
    });
    expect(result.prompts.map((turn) => turn.text)).toEqual([
      "Make the voice input start with Cmd-D.",
      "Now add a test for the Linux keymap.",
    ]);
    expect(result.lastReply?.text).toContain("keymap.linux.test.ts");

    const hits = store.search("c1", buildMatch("VOICE_KEY", "all")!, 5);
    expect(hits).toHaveLength(1);
    const lines = records.map((record) => JSON.stringify(record));
    const expectedLine = lines.findIndex((line) => line.includes("VOICE_KEY")) + 1;
    expect(hits[0]).toMatchObject({ kind: "tool_result", line: expectedLine });
    expect(hits[0]!.byteOffset).toBe(
      Buffer.byteLength(lines.slice(0, expectedLine - 1).join("\n")) + 1
    );
    expect(hits[0]!.excerpt).toContain("[VOICE_KEY]");
  });

  /** A rollout of assistant messages, one per text, after the session's meta. */
  async function indexTexts(id: string, texts: readonly string[]): Promise<IndexStore> {
    const { dir, store } = workspace();
    const source = join(dir, "rollout.jsonl");
    writeJsonl(source, [
      { type: "session_meta", payload: { id: CODEX_SESSION_ID } },
      ...texts.map((text) => ({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      })),
    ]);
    await convertSession(store, {
      id,
      agentId: "codex",
      sessionId: CODEX_SESSION_ID,
      path: source,
      signal: neverAborted,
      onProgress: () => {},
    });
    return store;
  }

  it("ranks the record that matches every word above ones that match some", async () => {
    // The weaker records come first in the file, so file order alone would rank them first.
    const store = await indexTexts("c2", [
      "the linux build is green",
      "a keymap change landed",
      "the linux keymap test fails on the shared replacement",
    ]);
    const hits = store.search("c2", buildMatch("linux keymap test", "any")!, 5);
    expect(hits.map((hit) => hit.line)).toHaveLength(3);
    expect(hits[0]!.line).toBe(4);
  });

  it("finds a phrase that crosses a chunk cut, and answers one hit per record", async () => {
    const text = `${"p ".repeat(1994)}alpha beta gamma ${"q ".repeat(3000)}`;
    const store = await indexTexts("c8", [text]);
    const hits = store.search("c8", buildMatch('"beta gamma"', "all")!, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.excerpt).toContain("[beta gamma]");
    // Every chunk holds "p" or "q": one record, however many chunks match.
    expect(store.search("c8", buildMatch("p q", "any")!, 5)).toHaveLength(1);
  });

  it("finds the longest phrase a query allows across a cut", async () => {
    const phrase = Array.from({ length: 74 }, () => "alpha").join(" ");
    const text = `${"p ".repeat(1785)}${phrase} ${"q ".repeat(3000)}`;
    const store = await indexTexts("c10", [text]);
    expect(phrase.length).toBeLessThanOrEqual(500);
    expect(store.search("c10", buildMatch(`"${phrase}"`, "all")!, 5)).toHaveLength(1);
  });

  it("counts the limit in records, so one record matching everywhere hides no other", async () => {
    const store = await indexTexts("c11", [
      "needle ".repeat(30_000),
      "one needle here",
      "and a needle there",
    ]);
    const lines = store.search("c11", buildMatch("needle", "all")!, 8).map((hit) => hit.line);
    expect(lines.sort()).toEqual([2, 3, 4]);
  });

  it("indexes a Claude Code transcript and leaves sidechains and thinking out", async () => {
    const { dir, store } = workspace();
    const source = join(dir, `${CLAUDE_SESSION_ID}.jsonl`);
    writeJsonl(source, claudeTranscript());
    const result = await convertSession(store, {
      id: "c3",
      agentId: "claude",
      sessionId: CLAUDE_SESSION_ID,
      path: source,
      signal: neverAborted,
      onProgress: () => {},
    });
    expect(result.prompts.map((turn) => turn.text)).toEqual([
      "/work 16097",
      "Use FTS5 for the search, not embeddings.",
    ]);
    expect(result.lastReply?.text).toBe("FTS5 it is: the index is\n\none SQLite file per session.");
    expect(store.search("c3", buildMatch("chatter", "any")!, 5)).toEqual([]);
    expect(store.search("c3", buildMatch("chain thought", "any")!, 5)).toEqual([]);
    expect(store.search("c3", buildMatch("embeddings", "all")!, 5)).toHaveLength(1);
  });

  it("refuses a file that doesn't open with the session it was located as, and keeps no index", async () => {
    const { dir, store } = workspace();
    const source = join(dir, "rollout.jsonl");
    writeJsonl(source, codexRollout());
    await expect(
      convertSession(store, {
        id: "c4",
        agentId: "codex",
        sessionId: "some-other-session",
        path: source,
        signal: neverAborted,
        onProgress: () => {},
      })
    ).rejects.toBeInstanceOf(SessionMismatchError);
    expect(readdirSync(join(dir, "sessions"))).toEqual([]);
  });

  it("removes the partial file when cancelled", async () => {
    const { dir, store } = workspace();
    const source = join(dir, "rollout.jsonl");
    writeJsonl(source, codexRollout());
    const controller = new AbortController();
    controller.abort();
    await expect(
      convertSession(store, {
        id: "c5",
        agentId: "codex",
        sessionId: CODEX_SESSION_ID,
        path: source,
        signal: controller.signal,
        onProgress: () => {},
      })
    ).rejects.toThrow();
    expect(readdirSync(join(dir, "sessions"))).toEqual([]);
  });

  it("reports skipped lines and still indexes the rest", async () => {
    const { dir, store } = workspace();
    const source = join(dir, "rollout.jsonl");
    const lines = codexRollout().map((record) => JSON.stringify(record));
    lines.splice(3, 0, "{ torn line");
    writeFileSync(source, `${lines.join("\n")}\n{"type":"respo`);
    const result = await convertSession(store, {
      id: "c6",
      agentId: "codex",
      sessionId: CODEX_SESSION_ID,
      path: source,
      signal: neverAborted,
      onProgress: () => {},
    });
    expect(result.skippedLines).toBe(2);
    expect(result.prompts).toHaveLength(2);
  });

  it("keeps the hand-off in the index, and deletes every file of an index", async () => {
    const { dir, store } = workspace();
    const source = join(dir, "rollout.jsonl");
    writeJsonl(source, codexRollout());
    await convertSession(store, {
      id: "c7",
      agentId: "codex",
      sessionId: CODEX_SESSION_ID,
      path: source,
      signal: neverAborted,
      onProgress: () => {},
    });
    await store.writeHandoff("c7", "the hand-off");
    expect(await store.readHandoff("c7")).toBe("the hand-off");
    expect(await store.sizeOf("c7")).toBeGreaterThan(0);
    for (const suffix of ["-journal", "-wal", "-shm", ".partial"]) {
      writeFileSync(`${store.pathOf("c7")}${suffix}`, "");
    }
    await store.delete("c7");
    expect(existsSync(store.pathOf("c7"))).toBe(false);
    expect(readdirSync(join(dir, "sessions"))).toEqual([]);
    expect(await store.sizeOf("c7")).toBeNull();
  });

  it("publishes nothing when cancelled after the last read", async () => {
    const { dir, store } = workspace();
    const source = join(dir, "rollout.jsonl");
    // 70 records of 64 KiB: progress first reports past 4 MiB, inside the
    // last 1 MiB read, so only the check after reading can see the cancel.
    const text = "w ".repeat(32 * 1024);
    writeJsonl(source, [
      { type: "session_meta", payload: { id: CODEX_SESSION_ID } },
      ...Array.from({ length: 70 }, () => ({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      })),
    ]);
    const controller = new AbortController();
    let reports = 0;
    await expect(
      convertSession(store, {
        id: "c9",
        agentId: "codex",
        sessionId: CODEX_SESSION_ID,
        path: source,
        signal: controller.signal,
        onProgress: () => {
          reports += 1;
          controller.abort();
        },
      })
    ).rejects.toThrow();
    expect(reports).toBe(1);
    expect(readdirSync(join(dir, "sessions"))).toEqual([]);
  });

  it("sweeps only partial builds", async () => {
    const { dir, store } = workspace();
    await store.ensureRoot();
    writeFileSync(join(dir, "sessions", "a.db.partial"), "");
    writeFileSync(join(dir, "sessions", "b.db"), "");
    await store.sweepPartials();
    expect(readdirSync(join(dir, "sessions"))).toEqual(["b.db"]);
  });

  it("refuses an id that could leave the index directory", () => {
    const { store } = workspace();
    expect(() => store.pathOf("../escape")).toThrow();
  });
});

describe("chunks", () => {
  it("cuts a long text without spaces into bounded chunks that cover it all and overlap", () => {
    const text = "x".repeat(1024 * 1024);
    let covered = 0;
    for (const [offset, chunk] of chunks(text)) {
      expect(chunk.length).toBeLessThanOrEqual(4_000);
      // Each chunk repeats more of the last one than the longest searchable phrase.
      if (covered > 0) expect(covered - offset).toBeGreaterThan(500);
      expect(text.slice(offset, offset + chunk.length)).toBe(chunk);
      covered = offset + chunk.length;
    }
    expect(covered).toBe(text.length);
  });

  it("never splits a surrogate pair", () => {
    // The leading "a" puts every pair at an odd offset, so plain cuts would split them.
    const text = `a${"😀".repeat(5_000)}`;
    const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
    const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
    for (const [, chunk] of chunks(text)) {
      expect(isLow(chunk.charCodeAt(0))).toBe(false);
      expect(isHigh(chunk.charCodeAt(chunk.length - 1))).toBe(false);
    }
  });
});

describe("search_converted results", () => {
  it("stay under the host's result limit, and say when they were cut", async () => {
    const records = Array.from({ length: 10 }, (_, index) => ({
      id: `c${index}`,
      projectId: "p1",
      terminalIds: ["t1"],
      sourceAgent: "codex",
      targetAgent: "claude",
      sourceSessionId: "s",
      sourcePath: "/sessions/rollout.jsonl",
      createdAt: index,
    }));
    const hit: SearchHit = {
      kind: "tool_result",
      line: 1,
      byteOffset: 0,
      charOffset: 0,
      timestamp: "2026-10-26T13:00:00.000Z",
      excerpt: "é".repeat(1_000),
    };
    const tool = createSearchTool({
      catalog: {
        list: async () => records,
        sharedProjects: async () => new Set<string>(),
      } as unknown as Catalog,
      store: { search: () => Array.from({ length: 25 }, () => hit) } as unknown as IndexStore,
      log: () => {},
    });
    const result = (await tool.execute(
      { query: "anything", limit: 25 },
      { credentialId: "c", projectId: "p1", terminalId: "t1" },
      new AbortController().signal
    )) as { truncated?: boolean; sessions: unknown[] };
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.sessions.length).toBeGreaterThan(1);
  });

  it("answer a session whose index is missing as missing, and still search the rest", async () => {
    // The missing index is the newest, so it is searched first.
    const records = ["here", "gone"].map((id, index) => ({
      id,
      projectId: "p1",
      terminalIds: ["t1"],
      sourceAgent: "codex",
      targetAgent: "claude",
      sourceSessionId: "s",
      sourcePath: "/p",
      createdAt: index,
    }));
    const tool = createSearchTool({
      catalog: {
        list: async () => records,
        sharedProjects: async () => new Set<string>(),
      } as unknown as Catalog,
      store: {
        search: (id: string) => {
          if (id === "gone") throw new Error("SQLITE_CANTOPEN");
          return [];
        },
      } as unknown as IndexStore,
      log: () => {},
    });
    const result = (await tool.execute(
      { query: "word" },
      { credentialId: "c", projectId: "p1", terminalId: "t1" },
      new AbortController().signal
    )) as { sessions: { convertedSessionId: string; error?: string }[] };
    expect(result.sessions.map((session) => [session.convertedSessionId, !!session.error])).toEqual(
      [
        ["gone", true],
        ["here", false],
      ]
    );
  });
});
