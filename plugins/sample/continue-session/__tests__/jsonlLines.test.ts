import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionSnapshot, readJsonlLines, type JsonlLine } from "../main/jsonlLines.js";
import { tempDir } from "./fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function readAll(path: string, maxLineBytes = 1024 * 1024): Promise<JsonlLine[]> {
  const snapshot = await openSessionSnapshot(path);
  try {
    const lines: JsonlLine[] = [];
    for await (const line of readJsonlLines(snapshot, { maxLineBytes })) lines.push(line);
    return lines;
  } finally {
    await snapshot.handle.close();
  }
}

function file(name: string, contents: string | Buffer): string {
  const dir = tempDir("lines");
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("readJsonlLines", () => {
  it("numbers physical lines and gives each line's byte offset, counting blank lines", async () => {
    const path = file("a.jsonl", '{"a":1}\n\n{"é":2}\r\n{"c":3}');
    const lines = await readAll(path);
    expect(lines.map((line) => [line.line, line.byteOffset, line.text])).toEqual([
      [1, 0, '{"a":1}'],
      [3, 9, '{"é":2}\r'],
      [4, 19, '{"c":3}'],
    ]);
    expect(lines[1]!.byteLength).toBe(Buffer.byteLength('{"é":2}\r'));
  });

  it("keeps a multi-byte character whole when it straddles a read chunk", async () => {
    // The 1 MiB read boundary falls inside the 4-byte emoji.
    const filler = "x".repeat(1024 * 1024 - 10);
    const line = `{"t":"${filler}😀"}`;
    const lines = await readAll(file("b.jsonl", `${line}\n{"n":2}\n`), 4 * 1024 * 1024);
    expect(lines[0]!.text).toBe(line);
    expect(lines[1]).toMatchObject({ line: 2, byteOffset: Buffer.byteLength(line) + 1 });
  });

  it("skips a line past the size limit without holding it, and keeps counting", async () => {
    const big = `{"t":"${"y".repeat(5000)}"}`;
    const lines = await readAll(file("c.jsonl", `{"a":1}\n${big}\n{"b":2}\n`), 1000);
    expect(lines.map((line) => [line.line, line.text])).toEqual([
      [1, '{"a":1}'],
      [2, null],
      [3, '{"b":2}'],
    ]);
    expect(lines[2]!.byteOffset).toBe(8 + big.length + 1);
  });

  it("reads only up to the size at open, so an append during the read isn't half-read", async () => {
    const path = file("d.jsonl", '{"a":1}\n');
    const snapshot = await openSessionSnapshot(path);
    appendFileSync(path, '{"b":2}\n');
    const lines: JsonlLine[] = [];
    for await (const line of readJsonlLines(snapshot, { maxLineBytes: 1024 })) lines.push(line);
    await snapshot.handle.close();
    expect(lines.map((line) => line.text)).toEqual(['{"a":1}']);
    expect(snapshot.bytes).toBe(8);
  });

  it("stops when its signal aborts", async () => {
    const path = file("e.jsonl", '{"a":1}\n'.repeat(10));
    const snapshot = await openSessionSnapshot(path);
    const controller = new AbortController();
    controller.abort();
    await expect(async () => {
      for await (const _line of readJsonlLines(snapshot, {
        maxLineBytes: 1024,
        signal: controller.signal,
      })) {
        // never reached
      }
    }).rejects.toThrow();
    await snapshot.handle.close();
  });

  it("refuses a directory", async () => {
    const dir = tempDir("dir");
    dirs.push(dir);
    await expect(openSessionSnapshot(dir)).rejects.toThrow();
  });
});
