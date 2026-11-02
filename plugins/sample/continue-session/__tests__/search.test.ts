import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversionRecord } from "../main/catalog.js";
import { convertSession, SessionMismatchError } from "../main/convert.js";
import { IndexStore } from "../main/indexStore.js";
import { buildMatch, canSearch } from "../main/search.js";
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
  const record = { projectId: "p1", terminalId: "t-continue" } as ConversionRecord;

  it("lets the continuing agent search its session", () => {
    expect(canSearch(record, { projectId: "p1", terminalId: "t-continue" }, new Set())).toBe(true);
  });

  it("refuses another terminal, and the same terminal id in another project", () => {
    expect(canSearch(record, { projectId: "p1", terminalId: "t-other" }, new Set())).toBe(false);
    expect(canSearch(record, { projectId: "p2", terminalId: "t-continue" }, new Set())).toBe(false);
  });

  it("refuses everyone while the continuing agent hasn't been launched", () => {
    const pending = { ...record, terminalId: null };
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

  it("ranks the record that matches every word above one that matches some", async () => {
    const { dir, store } = workspace();
    const source = join(dir, "rollout.jsonl");
    writeJsonl(source, codexRollout());
    await convertSession(store, {
      id: "c2",
      agentId: "codex",
      sessionId: CODEX_SESSION_ID,
      path: source,
      signal: neverAborted,
      onProgress: () => {},
    });
    const hits = store.search("c2", buildMatch("linux keymap test", "any")!, 5);
    expect(hits[0]!.excerpt).toMatch(/\[keymap\]\.\[linux\]\.\[test\]|\[Linux\] \[keymap\]/);
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
    await store.delete("c7");
    expect(existsSync(store.pathOf("c7"))).toBe(false);
    expect(await store.sizeOf("c7")).toBeNull();
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
