import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash } from "node:crypto";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock("../../utils.js", () => ({
  checkRateLimit: vi.fn(),
}));

import { readFileDocument, saveFileDocument } from "../fileDocument.js";
import type { IpcContext } from "../../types.js";

const ctx = {} as IpcContext;
const MAX = 1024 * 1024;

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("fileDocument handlers (#13809)", () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "file-document-")));
    file = path.join(root, "data.csv");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reads text with a content revision, stripping a BOM and CRLF", async () => {
    const bytes = Buffer.from("﻿a,b\r\n1,2\r\n", "utf-8");
    await fs.writeFile(file, bytes);
    const result = await readFileDocument(ctx, { rootPath: root, filePath: file, maxBytes: MAX });
    expect(result).toEqual({ status: "ok", text: "a,b\n1,2\n", revision: sha(bytes) });
  });

  it("refuses a file outside the root, a missing file, an oversized one and non-UTF-8", async () => {
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.csv`);
    await fs.writeFile(outside, "x");
    try {
      expect(
        await readFileDocument(ctx, { rootPath: root, filePath: outside, maxBytes: MAX })
      ).toEqual({ status: "unavailable" });
    } finally {
      await fs.rm(outside, { force: true });
    }
    expect(await readFileDocument(ctx, { rootPath: root, filePath: file, maxBytes: MAX })).toEqual({
      status: "unavailable",
    });

    await fs.writeFile(file, "0123456789");
    expect(await readFileDocument(ctx, { rootPath: root, filePath: file, maxBytes: 4 })).toEqual({
      status: "too-large",
    });

    await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0x00]));
    expect(await readFileDocument(ctx, { rootPath: root, filePath: file, maxBytes: MAX })).toEqual({
      status: "not-text",
    });
  });

  it("saves against the expected revision, keeping the file's BOM and line ending", async () => {
    const original = Buffer.from("﻿a\r\nb\r\n", "utf-8");
    await fs.writeFile(file, original);
    const result = await saveFileDocument(ctx, {
      rootPath: root,
      filePath: file,
      maxBytes: MAX,
      text: "a\nc\n",
      expectedRevision: sha(original),
    });
    const written = await fs.readFile(file);
    expect(written.equals(Buffer.from("﻿a\r\nc\r\n", "utf-8"))).toBe(true);
    expect(result).toEqual({ status: "saved", revision: sha(written) });
  });

  it("refuses a stale save as a conflict and writes nothing", async () => {
    await fs.writeFile(file, "one\n");
    const stale = sha("one\n");
    await fs.writeFile(file, "two\n");
    const result = await saveFileDocument(ctx, {
      rootPath: root,
      filePath: file,
      maxBytes: MAX,
      text: "mine\n",
      expectedRevision: stale,
    });
    expect(result).toEqual({ status: "conflict", revision: sha("two\n") });
    expect(await fs.readFile(file, "utf-8")).toBe("two\n");
  });

  it("reports a deleted file as a conflict with no revision", async () => {
    const result = await saveFileDocument(ctx, {
      rootPath: root,
      filePath: file,
      maxBytes: MAX,
      text: "x",
      expectedRevision: sha("gone"),
    });
    expect(result).toEqual({ status: "conflict", revision: null });
  });

  it("refuses a save over the editor's byte ceiling", async () => {
    await fs.writeFile(file, "a");
    const result = await saveFileDocument(ctx, {
      rootPath: root,
      filePath: file,
      maxBytes: 4,
      text: "0123456789",
      expectedRevision: sha("a"),
    });
    expect(result).toEqual({ status: "refused", reason: "too-large" });
    expect(await fs.readFile(file, "utf-8")).toBe("a");
  });
});
