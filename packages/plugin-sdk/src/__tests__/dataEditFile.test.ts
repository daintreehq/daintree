import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { contentRevision, editFile, updateFrontmatter, type EditFileHost } from "../data.js";
import { createMockHost } from "../testing.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * A byte store with the host's checked-write contract. Errors carry only a
 * message, as they do once they have crossed the plugin worker port.
 */
function createFakeHost(initial: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(initial)) {
    files.set(path, typeof value === "string" ? new TextEncoder().encode(value) : value);
  }
  const beforeWrite: Array<() => void> = [];
  const writes: string[] = [];
  const host: EditFileHost = {
    fs: {
      readFileBytes: vi.fn(async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        return new Uint8Array(bytes);
      }),
      writeFile: vi.fn(async (path: string, contents: string, options) => {
        beforeWrite.shift()?.();
        const existing = files.get(path);
        const expected = options?.expectedRevision;
        if (expected === null && existing) {
          throw new Error(`TARGET_EXISTS: Plugin "p" fs.writeFile: the target already exists`);
        }
        if (typeof expected === "string") {
          if (!existing) {
            throw new Error(
              `TARGET_UNAVAILABLE: Plugin "p" fs.writeFile: the target no longer exists`
            );
          }
          if (sha256(existing) !== expected) {
            throw new Error(
              `REVISION_MISMATCH: Plugin "p" fs.writeFile: the file changed since it was read`
            );
          }
        }
        const bytes = new TextEncoder().encode(contents);
        files.set(path, bytes);
        writes.push(contents);
        return { revision: sha256(bytes) };
      }),
    },
  };
  const text = (path: string) =>
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(files.get(path));
  const set = (path: string, value: string) => files.set(path, new TextEncoder().encode(value));
  return { host, files, writes, beforeWrite, text, set };
}

describe("editFile", () => {
  it("writes the transformed text against the revision it read", async () => {
    const fake = createFakeHost({ "/p/card.md": "---\nstage: lead\n---\nbody\n" });
    const result = await editFile(fake.host, "/p/card.md", (text) =>
      updateFrontmatter(text ?? "", { stage: "won" })
    );
    expect(fake.text("/p/card.md")).toBe("---\nstage: won\n---\nbody\n");
    expect(result).toEqual({
      written: true,
      revision: await contentRevision(fake.text("/p/card.md")),
    });
    expect(fake.host.fs.writeFile).toHaveBeenCalledWith("/p/card.md", expect.any(String), {
      expectedRevision: await contentRevision("---\nstage: lead\n---\nbody\n"),
    });
  });

  it("re-reads and re-applies when another writer got in first, keeping both edits", async () => {
    const fake = createFakeHost({ "/p/card.md": "---\nstage: lead\nowner: greg\n---\n" });
    // An agent rewrites the owner between our read and our write, twice.
    fake.beforeWrite.push(
      () => fake.set("/p/card.md", "---\nstage: lead\nowner: ana\n---\n"),
      () => fake.set("/p/card.md", "---\nstage: lead\nowner: bo\n---\n")
    );
    const transform = vi.fn((text: string | null) =>
      updateFrontmatter(text ?? "", { stage: "won" })
    );

    const result = await editFile(fake.host, "/p/card.md", transform);

    expect(result.written).toBe(true);
    expect(fake.text("/p/card.md")).toBe("---\nstage: won\nowner: bo\n---\n");
    expect(transform).toHaveBeenCalledTimes(3);
    expect(transform.mock.calls.map(([text]) => text)).toEqual([
      "---\nstage: lead\nowner: greg\n---\n",
      "---\nstage: lead\nowner: ana\n---\n",
      "---\nstage: lead\nowner: bo\n---\n",
    ]);
  });

  it("gives up after the configured retries and throws the conflict", async () => {
    const fake = createFakeHost({ "/p/log.txt": "a\n" });
    let n = 0;
    for (let i = 0; i < 3; i++) fake.beforeWrite.push(() => fake.set("/p/log.txt", `x${n++}\n`));
    await expect(
      editFile(fake.host, "/p/log.txt", (text) => `${text}b\n`, { retries: 2 })
    ).rejects.toThrow(/^REVISION_MISMATCH:/);
    expect(fake.host.fs.writeFile).toHaveBeenCalledTimes(3);
    expect(fake.writes).toEqual([]);
  });

  it("does not write when the transform returns the same text, null or undefined", async () => {
    const fake = createFakeHost({ "/p/a.md": "same\n" });
    const revision = await contentRevision("same\n");
    for (const transform of [(t: string | null) => t, () => null, () => undefined]) {
      expect(await editFile(fake.host, "/p/a.md", transform)).toEqual({ written: false, revision });
    }
    expect(fake.host.fs.writeFile).not.toHaveBeenCalled();
  });

  it("creates a missing file as a create-new write, and retries if it appears first", async () => {
    const fake = createFakeHost();
    fake.beforeWrite.push(() => fake.set("/p/new.jsonl", '{"first":true}\n'));
    const transform = vi.fn((text: string | null) => `${text ?? ""}{"second":true}\n`);

    const result = await editFile(fake.host, "/p/new.jsonl", transform);

    expect(result.written).toBe(true);
    expect(transform.mock.calls.map(([text]) => text)).toEqual([null, '{"first":true}\n']);
    expect(fake.host.fs.writeFile).toHaveBeenNthCalledWith(1, "/p/new.jsonl", expect.any(String), {
      expectedRevision: null,
    });
    expect(fake.text("/p/new.jsonl")).toBe('{"first":true}\n{"second":true}\n');
  });

  it("leaves a missing file absent when the transform declines to create it", async () => {
    const fake = createFakeHost();
    expect(await editFile(fake.host, "/p/none.md", () => null)).toEqual({
      written: false,
      revision: null,
    });
  });

  it("hashes the bytes on disk, so a byte order mark does not read as a conflict", async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a: 1\n")]);
    const fake = createFakeHost({ "/p/bom.yaml": withBom });
    const result = await editFile(fake.host, "/p/bom.yaml", (text) => text?.replace("1", "2"));
    expect(result.written).toBe(true);
    expect(fake.text("/p/bom.yaml")).toBe("\uFEFFa: 2\n");
    expect(fake.host.fs.writeFile).toHaveBeenCalledWith("/p/bom.yaml", "\uFEFFa: 2\n", {
      expectedRevision: sha256(withBom),
    });
  });

  it("refuses a file that is not valid UTF-8 instead of corrupting it", async () => {
    const fake = createFakeHost({ "/p/bin": new Uint8Array([0x61, 0xff, 0x62]) });
    const transform = vi.fn(() => "x");
    await expect(editFile(fake.host, "/p/bin", transform)).rejects.toThrow(/not valid UTF-8/);
    expect(transform).not.toHaveBeenCalled();
  });

  it("does not retry an error that is not a conflict", async () => {
    const fake = createFakeHost({ "/p/a.md": "a" });
    vi.mocked(fake.host.fs.writeFile).mockRejectedValueOnce(
      new Error('PERMISSION_REQUIRED: plugin "p" fs.writeFile requires "fs:project-write"')
    );
    await expect(editFile(fake.host, "/p/a.md", () => "b")).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(fake.host.fs.writeFile).toHaveBeenCalledTimes(1);
  });

  it("matches the conflict code on an in-process error object too", async () => {
    const fake = createFakeHost({ "/p/a.md": "a" });
    vi.mocked(fake.host.fs.writeFile).mockRejectedValueOnce(
      Object.assign(new Error("the file changed since it was read"), { code: "REVISION_MISMATCH" })
    );
    expect(await editFile(fake.host, "/p/a.md", () => "b")).toMatchObject({ written: true });
    expect(fake.host.fs.writeFile).toHaveBeenCalledTimes(2);
  });

  it("rejects a negative or fractional retry count", async () => {
    const fake = createFakeHost();
    await expect(editFile(fake.host, "/p/a", () => null, { retries: -1 })).rejects.toThrow(
      TypeError
    );
    await expect(editFile(fake.host, "/p/a", () => null, { retries: 1.5 })).rejects.toThrow(
      TypeError
    );
  });

  it("works against the SDK's mock host", async () => {
    const host = createMockHost({ pluginId: "acme.crm" });
    await host.fs.writeFile("/p/card.md", "---\nstage: lead\n---\n");
    const result = await editFile(host, "/p/card.md", (text) =>
      updateFrontmatter(text ?? "", { stage: "won" })
    );
    expect(result.written).toBe(true);
    expect(await host.fs.readFile("/p/card.md")).toBe("---\nstage: won\n---\n");
  });
});
