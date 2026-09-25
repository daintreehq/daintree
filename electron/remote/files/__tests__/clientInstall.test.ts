import os from "node:os";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
  protocol: { handle: vi.fn() },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import type { FileTransferEvent } from "../../../../shared/types/ipc/fileTransfer.js";
import type { ClientFileTransport, DownloadOptions } from "../ClientFileTransport.js";
import { createHostFileClient } from "../clientInstall.js";
import type { HostPickerBridge } from "../HostPickerBridge.js";
import { ViewFileCapabilities } from "../viewCapabilities.js";

function setup(bound: string | null = "studio-01") {
  const events: FileTransferEvent[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const download = vi.fn(async (_host: string, _path: string, options: DownloadOptions) => {
    options.onProgress?.(10, 100);
    options.onProgress?.(20, 100);
    await gate;
    if (options.signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "CANCELLED" });
    options.onProgress?.(100, 100);
    return { localPath: `${options.destinationDir}/report.bin`, bytes: 100 };
  });
  const client = createHostFileClient({
    transport: { download } as unknown as ClientFileTransport,
    pickers: {} as HostPickerBridge,
    capabilities: new ViewFileCapabilities(() => () => {}),
    hostForView: () => bound,
    sendToView: (_wc, event) => events.push(event),
    downloadsDir: () => "/Users/greg/Downloads",
    tempDir: () => os.tmpdir(),
  });
  return { client, download, events, release };
}

const payload = { hostId: "studio-01", hostPath: "/srv/app/report.bin", opId: "op-1" };

describe("createHostFileClient.download", () => {
  it("saves into Downloads and reports progress to the asking view", async () => {
    const { client, events, release } = setup();
    const pending = client.download(7, payload);
    release();
    await expect(pending).resolves.toEqual({
      localPath: "/Users/greg/Downloads/report.bin",
      bytes: 100,
    });
    const progress = events.filter((event) => event.type === "progress");
    expect(progress[0]).toEqual({
      type: "progress",
      opId: "op-1",
      transferredBytes: 10,
      totalBytes: 100,
    });
    // Throttled in between, but the final byte count always goes out.
    expect(progress.at(-1)).toMatchObject({ transferredBytes: 100 });
    expect(progress.length).toBeLessThan(3 + 1);
  });

  it("joins a retry carrying the same operation id instead of downloading twice", async () => {
    const { client, download, release } = setup();
    const first = client.download(7, payload);
    const second = client.download(7, payload);
    release();
    await Promise.all([first, second]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("cancels by operation id", async () => {
    const { client, release } = setup();
    const pending = client.download(7, payload);
    expect(client.cancel("op-1")).toBe(true);
    release();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(client.cancel("op-1")).toBe(false);
  });

  it("refuses a file on a host the view isn't attached to", async () => {
    const { client, download } = setup("studio-02");
    expect(() => client.download(7, payload)).toThrow(/not attached/);
    const local = setup(null);
    expect(() => local.client.download(7, payload)).toThrow();
    expect(download).not.toHaveBeenCalled();
  });

  it("validates the request", () => {
    const { client } = setup();
    for (const bad of [
      { ...payload, hostId: "local" },
      { ...payload, hostPath: "relative/path" },
      { ...payload, hostPath: "/a\0b" },
      { ...payload, opId: "" },
    ]) {
      expect(() => client.download(7, bad)).toThrow();
    }
  });
});

describe("preview capabilities", () => {
  it("mints one capability per remote view and has none for a local view", () => {
    const { client } = setup();
    const token = client.previewCapability(7);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(client.previewCapability(7)).toBe(token);
    expect(client.previewCapability(8)).not.toBe(token);
    expect(setup(null).client.previewCapability(7)).toBeNull();
  });

  it("forgets a view's capability once the view is gone", () => {
    const gone = new Map<number, () => void>();
    const capabilities = new ViewFileCapabilities((webContentsId, onGone) => {
      gone.set(webContentsId, onGone);
      return () => gone.delete(webContentsId);
    });
    const token = capabilities.capabilityFor(7);
    expect(capabilities.viewFor(token)).toBe(7);
    gone.get(7)!();
    expect(capabilities.viewFor(token)).toBeNull();
    expect(capabilities.capabilityFor(7)).not.toBe(token);
    capabilities.dispose();
    expect(gone.size).toBe(0);
  });
});
