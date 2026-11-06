import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  createFromBuffer: vi.fn(),
  createEmpty: vi.fn(),
}));

vi.mock("electron", () => ({
  clipboard: { read: mocks.read, write: mocks.write },
  nativeImage: { createFromBuffer: mocks.createFromBuffer, createEmpty: mocks.createEmpty },
  ClipboardItem: class {
    constructor(readonly data: Record<string, Blob>) {}
  },
}));

import {
  readClipboardImage,
  writeClipboardFileFormat,
  writeClipboardImage,
} from "../clipboardAccess.js";
import type { NativeImage } from "electron";

describe("Electron clipboard access", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.write.mockResolvedValue(undefined);
  });

  it("reads and decodes an image after obtaining its asynchronous payload", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const image = { isEmpty: () => false };
    const getType = vi.fn(async () => new Blob([png]));
    mocks.read.mockResolvedValue([{ types: ["text/plain", "image/png"], getType }]);
    mocks.createFromBuffer.mockReturnValue(image);

    expect(await readClipboardImage()).toBe(image);
    expect(getType).toHaveBeenCalledWith("image/png");
    expect(mocks.createFromBuffer).toHaveBeenCalledWith(Buffer.from(png));
  });

  it("returns an empty image for a clipboard containing only text", async () => {
    const empty = { isEmpty: () => true };
    mocks.read.mockResolvedValue([{ types: ["text/plain"] }]);
    mocks.createEmpty.mockReturnValue(empty);

    expect(await readClipboardImage()).toBe(empty);
    expect(mocks.createFromBuffer).not.toHaveBeenCalled();
  });

  it("continues past an undecodable image entry", async () => {
    const image = { isEmpty: () => false };
    mocks.read.mockResolvedValue([
      { types: ["image/png"], getType: async () => new Blob([new Uint8Array([0])]) },
      { types: ["image/jpeg"], getType: async () => new Blob([new Uint8Array([1])]) },
    ]);
    mocks.createFromBuffer.mockReturnValueOnce({ isEmpty: () => true }).mockReturnValueOnce(image);

    expect(await readClipboardImage()).toBe(image);
  });

  it("writes the image's PNG bytes and waits for the OS write", async () => {
    let resolve!: () => void;
    mocks.write.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      })
    );
    const backing = new Uint8Array([99, 1, 2, 3, 99]);
    const image = { toPNG: () => backing.subarray(1, 4) } as unknown as NativeImage;
    let finished = false;
    const write = writeClipboardImage(image).then(() => {
      finished = true;
    });
    const payload = mocks.write.mock.calls[0]![0][0].data["image/png"] as Blob;

    expect(Array.from(new Uint8Array(await payload.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(payload.type).toBe("image/png");
    expect(finished).toBe(false);
    resolve();
    await write;
    expect(finished).toBe(true);
  });

  it("propagates an asynchronous clipboard refusal", async () => {
    mocks.write.mockRejectedValue(new Error("clipboard unavailable"));
    const image = { toPNG: () => Buffer.from([1]) } as NativeImage;

    await expect(writeClipboardImage(image)).rejects.toThrow("clipboard unavailable");
  });

  it.each([
    ["NSFilenamesPboardType", 'electron application/osclipboard;format="NSFilenamesPboardType"'],
    ["text/uri-list", "text/uri-list"],
  ] as const)(
    "writes %s using the corresponding Electron MIME representation",
    async (format, type) => {
      const bytes = Buffer.from("file:///tmp/a%20b.xml\r\n");
      await writeClipboardFileFormat(format, bytes);
      const payload = mocks.write.mock.calls[0]![0][0].data[type] as Blob;

      expect(Buffer.from(await payload.arrayBuffer())).toEqual(bytes);
    }
  );
});
