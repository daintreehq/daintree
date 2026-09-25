import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { materialize, setRemoteMaterializer } from "../materialize";

describe("materialize", () => {
  const saveImage = vi.fn();

  beforeEach(() => {
    saveImage.mockResolvedValue({
      filePath: "/tmp/daintree-clipboard/clipboard-1.png",
      thumbnailDataUrl: "data:x",
    });
    vi.stubGlobal("window", { electron: { clipboard: { saveImage } } });
  });

  afterEach(() => {
    setRemoteMaterializer(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("is the identity for local and host files in local mode", async () => {
    await expect(materialize({ kind: "local-file", path: "/Users/me/a b.png" })).resolves.toEqual({
      hostPath: "/Users/me/a b.png",
      displayName: "a b.png",
      bytes: null,
    });
    await expect(
      materialize({ kind: "host-file", path: "/srv/x/", hostId: "local" })
    ).resolves.toMatchObject({
      hostPath: "/srv/x/",
      displayName: "x",
    });
    expect(saveImage).not.toHaveBeenCalled();
  });

  it("refuses a file from another host when the window is local", async () => {
    await expect(
      materialize({ kind: "host-file", path: "/srv/a", hostId: "studio-01" })
    ).rejects.toThrow(/another host/);
  });

  it("keeps today's temp-file save for a clipboard image", async () => {
    await expect(materialize({ kind: "clipboard-image" })).resolves.toEqual({
      hostPath: "/tmp/daintree-clipboard/clipboard-1.png",
      displayName: "clipboard-1.png",
      bytes: null,
      thumbnail: "data:x",
    });
  });

  it("routes every source through the remote materializer while one is installed", async () => {
    const remote = vi.fn().mockResolvedValue({
      hostPath: "/tmp/daintree-inbox/files/a.png",
      displayName: "a.png",
      bytes: 3,
    });
    setRemoteMaterializer(remote);
    const result = await materialize({ kind: "local-file", path: "/Users/me/a.png" });
    expect(result.hostPath).toBe("/tmp/daintree-inbox/files/a.png");
    expect(remote).toHaveBeenCalledWith({ kind: "local-file", path: "/Users/me/a.png" }, undefined);
  });
});
