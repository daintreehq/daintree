import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildStubExpected,
  corpusEntriesToCast,
  corpusLooksSynthetic,
  writeCastFixture,
} from "../jsonl-to-cast.js";
import type { CorpusEntry } from "../types.js";

function entry(time: number, chunk: string, overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  return {
    time,
    chunk,
    detectedState: "working",
    confidence: 0.9,
    agentId: "claude",
    ...overrides,
  };
}

const BASE_OPTS = { width: 80, height: 30, title: "test-fixture" };

describe("corpusLooksSynthetic", () => {
  it("is true for bare strings without control characters", () => {
    expect(corpusLooksSynthetic([entry(0, "Aider v0.86.0"), entry(1, "> ")])).toBe(true);
  });

  it("is false when any chunk carries line discipline or ANSI", () => {
    expect(corpusLooksSynthetic([entry(0, "boot\r\n")])).toBe(false);
    expect(corpusLooksSynthetic([entry(0, "plain"), entry(1, "\u001b[2Kspinner")])).toBe(false);
  });
});

describe("corpusEntriesToCast", () => {
  it("maps entries 1:1 to v2 output events with absolute times", () => {
    const cast = corpusEntriesToCast([entry(0.5, "hello\r\n"), entry(2.25, "world\r\n")], {
      ...BASE_OPTS,
      lineEvents: false,
    });
    const lines = cast.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ version: 2, width: 80, height: 30 });
    expect(JSON.parse(lines[1])).toEqual([0.5, "o", "hello\r\n"]);
    expect(JSON.parse(lines[2])).toEqual([2.25, "o", "world\r\n"]);
  });

  it("redacts secrets and user paths in chunk data", () => {
    const key = "sk-ant-" + "a1b2c3d4e5".repeat(10);
    const cast = corpusEntriesToCast(
      [entry(0, `key=${key} in /Users/alice/project at git@github.com:acme/private.git`)],
      BASE_OPTS
    );
    expect(cast).not.toContain(key);
    expect(cast).not.toContain("alice");
    expect(cast).not.toContain("acme/private");
    expect(cast).toContain("[REDACTED]");
    expect(cast).toContain("/Users/USER/project");
  });

  it("round-trips ANSI and control sequences through JSON", () => {
    const chunk = "\u001b[2K\r⠙ Working… \u001b]9;4;1;50\u0007";
    const cast = corpusEntriesToCast([entry(0.1, chunk)], { ...BASE_OPTS, lineEvents: false });
    const lines = cast.trimEnd().split("\n");
    expect(JSON.parse(lines[1])[2]).toBe(chunk);
  });

  it("prepends CRLF to every event after the first in line-events mode", () => {
    const cast = corpusEntriesToCast([entry(0, "first"), entry(1, "second")], {
      ...BASE_OPTS,
      lineEvents: true,
    });
    const lines = cast.trimEnd().split("\n");
    expect(JSON.parse(lines[1])[2]).toBe("first");
    expect(JSON.parse(lines[2])[2]).toBe("\r\nsecond");
  });

  it("auto-enables line events for synthetic corpora", () => {
    const cast = corpusEntriesToCast([entry(0, "first"), entry(1, "second")], BASE_OPTS);
    const lines = cast.trimEnd().split("\n");
    expect(JSON.parse(lines[2])[2]).toBe("\r\nsecond");
  });

  it("keeps raw chunks verbatim when the corpus carries its own line discipline", () => {
    const cast = corpusEntriesToCast([entry(0, "first\r\n"), entry(1, "second")], BASE_OPTS);
    const lines = cast.trimEnd().split("\n");
    expect(JSON.parse(lines[2])[2]).toBe("second");
  });

  it("scrubs the header title", () => {
    const cast = corpusEntriesToCast([entry(0, "x")], {
      ...BASE_OPTS,
      title: "capture of /Users/alice/secret",
    });
    const header = JSON.parse(cast.split("\n")[0]);
    expect(header.title).toBe("capture of /Users/USER/secret");
  });

  it("throws on an empty corpus", () => {
    expect(() => corpusEntriesToCast([], BASE_OPTS)).toThrow(/empty/i);
  });
});

describe("buildStubExpected", () => {
  it("produces a stub that cannot pass the replay matcher", () => {
    const stub = JSON.parse(buildStubExpected("aider"));
    expect(stub.agentId).toBe("aider");
    expect(stub.transitions).toHaveLength(1);
    expect(stub.transitions[0].trigger).toBe("STUB_REPLACE_ME");
    expect(stub._stub).toContain("Calibrate");
  });
});

describe("writeCastFixture", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-to-cast-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the cast and a stub expected file", () => {
    const base = path.join(dir, "agent-scenario");
    const result = writeCastFixture(base, "CAST\n", "STUB\n");
    expect(result.wroteExpected).toBe(true);
    expect(fs.readFileSync(`${base}.cast`, "utf8")).toBe("CAST\n");
    expect(fs.readFileSync(`${base}.expected.json`, "utf8")).toBe("STUB\n");
  });

  it("never overwrites an existing expected file", () => {
    const base = path.join(dir, "agent-scenario");
    fs.writeFileSync(`${base}.expected.json`, "CALIBRATED\n", "utf8");
    const result = writeCastFixture(base, "CAST\n", "STUB\n");
    expect(result.wroteExpected).toBe(false);
    expect(fs.readFileSync(`${base}.expected.json`, "utf8")).toBe("CALIBRATED\n");
  });

  it("accepts an out base that already ends in .cast", () => {
    const base = path.join(dir, "agent-scenario.cast");
    const result = writeCastFixture(base, "CAST\n", "STUB\n");
    expect(result.castPath).toBe(path.join(dir, "agent-scenario.cast"));
    expect(result.expectedPath).toBe(path.join(dir, "agent-scenario.expected.json"));
    expect(fs.existsSync(path.join(dir, "agent-scenario.cast.cast"))).toBe(false);
  });
});
