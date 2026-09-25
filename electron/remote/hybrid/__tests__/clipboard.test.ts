import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: { readImage: vi.fn() } }));

import { CHANNELS } from "../../../ipc/channels.js";
import type { HybridSplit } from "../../../ipc/endpoint.js";
import { createClipboardSplits } from "../clipboard.js";

function fakeImage(empty: boolean) {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  return {
    isEmpty: () => empty,
    toPNG: () => png,
    getSize: () => ({ width: 80, height: 40 }),
    resize: vi.fn(() => ({ toPNG: () => Buffer.from("thumb") })),
  } as unknown as Electron.NativeImage;
}

function call(split: HybridSplit, local = vi.fn(async () => ["/Users/me/a.png"])) {
  return split({
    hostId: "studio-01",
    webContentsId: 7,
    args: [],
    local,
    remote: vi.fn(async () => {
      throw new Error("the host leg must not run");
    }),
  });
}

describe("clipboard splits for a remote window", () => {
  it("captures the image here, uploads it to the host inbox and builds the thumbnail locally", async () => {
    const uploadClipboardImage = vi.fn(async () => "/tmp/daintree-inbox/clipboard/clipboard-1.png");
    const splits = createClipboardSplits({
      readImage: () => fakeImage(false),
      uploader: () => ({ uploadClipboardImage, grantLocalSources: vi.fn() }),
    });
    const result = await call(splits[CHANNELS.CLIPBOARD_SAVE_IMAGE]!);
    expect(result).toEqual({
      filePath: "/tmp/daintree-inbox/clipboard/clipboard-1.png",
      thumbnailDataUrl: `data:image/png;base64,${Buffer.from("thumb").toString("base64")}`,
    });
    expect(uploadClipboardImage).toHaveBeenCalledWith(7, "studio-01", expect.any(Uint8Array));
  });

  it("reports an empty clipboard without uploading anything", async () => {
    const uploadClipboardImage = vi.fn();
    const splits = createClipboardSplits({
      readImage: () => fakeImage(true),
      uploader: () => ({ uploadClipboardImage, grantLocalSources: vi.fn() }),
    });
    await expect(call(splits[CHANNELS.CLIPBOARD_SAVE_IMAGE]!)).rejects.toMatchObject({
      code: "CLIPBOARD_EMPTY",
    });
    expect(uploadClipboardImage).not.toHaveBeenCalled();
  });

  it("opens the attach dialog on this machine", async () => {
    const splits = createClipboardSplits({
      readImage: () => fakeImage(true),
      uploader: () => undefined,
    });
    const local = vi.fn(async () => ["/Users/me/a.png"]);
    await expect(call(splits[CHANNELS.CLIPBOARD_PICK_ATTACHMENTS]!, local)).resolves.toEqual([
      "/Users/me/a.png",
    ]);
    expect(local).toHaveBeenCalled();
  });

  it("records what the dialog returned as chosen in this view, and nothing for a dismissal", async () => {
    const grantLocalSources = vi.fn();
    const splits = createClipboardSplits({
      readImage: () => fakeImage(true),
      uploader: () => ({ uploadClipboardImage: vi.fn(), grantLocalSources }),
    });
    await call(splits[CHANNELS.CLIPBOARD_PICK_ATTACHMENTS]!);
    expect(grantLocalSources).toHaveBeenCalledWith(7, ["/Users/me/a.png"]);
    await call(
      splits[CHANNELS.CLIPBOARD_PICK_ATTACHMENTS]!,
      vi.fn(async () => [])
    );
    expect(grantLocalSources).toHaveBeenCalledTimes(1);
  });
});
