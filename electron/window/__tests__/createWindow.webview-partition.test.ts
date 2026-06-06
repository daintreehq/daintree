import { describe, it, expect } from "vitest";
import { isLocalhostUrl, isDevPreviewProxyUrl } from "../../../shared/utils/urlUtils.js";
import { isBrowserPartition } from "../../../shared/utils/partitionUtils.js";

/**
 * Tests the will-attach-webview handler logic from createWindow.ts.
 *
 * The handler is inlined in setupBrowserWindow, so we replicate its exact
 * logic here to verify the partition preservation fix (#4564) and the
 * per-project browser partition support (#9965).
 *
 * If createWindow.ts changes, these tests should be updated to match.
 */

function simulateWillAttachWebview(
  webPreferences: Record<string, unknown>,
  params: { src: string; partition?: string }
): { prevented: boolean } {
  const isAllowedLocalhostUrl = isLocalhostUrl(params.src) || isDevPreviewProxyUrl(params.src);
  const partition = params.partition ?? "";
  const isValidPartition =
    isBrowserPartition(partition) ||
    partition === "persist:dev-preview" ||
    partition.startsWith("persist:dev-preview-");

  if (!isAllowedLocalhostUrl || !isValidPartition) {
    return { prevented: true };
  }

  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.navigateOnDragDrop = false;
  webPreferences.disableBlinkFeatures = "Auxclick";
  // This is the fix from #4564 — partition must be explicitly set
  webPreferences.partition = params.partition;

  return { prevented: false };
}

describe("will-attach-webview partition preservation (#4564)", () => {
  it("sets webPreferences.partition for a per-project browser partition", () => {
    const webPreferences: Record<string, unknown> = {
      preload: "/some/path",
      nodeIntegration: true,
    };

    const result = simulateWillAttachWebview(webPreferences, {
      src: "http://localhost:3000",
      partition: "persist:browser-project-1",
    });

    expect(result.prevented).toBe(false);
    expect(webPreferences.partition).toBe("persist:browser-project-1");
    expect(webPreferences.sandbox).toBe(true);
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.preload).toBeUndefined();
  });

  it("still accepts the legacy bare persist:browser partition", () => {
    const webPreferences: Record<string, unknown> = {};

    const result = simulateWillAttachWebview(webPreferences, {
      src: "http://localhost:3000",
      partition: "persist:browser",
    });

    expect(result.prevented).toBe(false);
    expect(webPreferences.partition).toBe("persist:browser");
  });

  it("blocks browser-like partitions that are not valid (over-match guard)", () => {
    const webPreferences: Record<string, unknown> = {};

    const result = simulateWillAttachWebview(webPreferences, {
      src: "http://localhost:3000",
      partition: "persist:browserish",
    });

    expect(result.prevented).toBe(true);
    expect(webPreferences.partition).toBeUndefined();
  });

  it("sets webPreferences.partition for dynamic dev-preview partition", () => {
    const webPreferences: Record<string, unknown> = {};

    const result = simulateWillAttachWebview(webPreferences, {
      src: "http://localhost:5173",
      partition: "persist:dev-preview-proj1-wt1-panel1",
    });

    expect(result.prevented).toBe(false);
    expect(webPreferences.partition).toBe("persist:dev-preview-proj1-wt1-panel1");
  });

  it("sets webPreferences.partition for persist:dev-preview", () => {
    const webPreferences: Record<string, unknown> = {};

    const result = simulateWillAttachWebview(webPreferences, {
      src: "http://127.0.0.1:3000",
      partition: "persist:dev-preview",
    });

    expect(result.prevented).toBe(false);
    expect(webPreferences.partition).toBe("persist:dev-preview");
  });

  it("blocks webview with invalid partition", () => {
    const webPreferences: Record<string, unknown> = {};

    const result = simulateWillAttachWebview(webPreferences, {
      src: "http://localhost:3000",
      partition: "evil-partition",
    });

    expect(result.prevented).toBe(true);
    expect(webPreferences.partition).toBeUndefined();
  });

  it("blocks webview with non-localhost URL", () => {
    const webPreferences: Record<string, unknown> = {};

    const result = simulateWillAttachWebview(webPreferences, {
      src: "https://evil.com",
      partition: "persist:browser",
    });

    expect(result.prevented).toBe(true);
    expect(webPreferences.partition).toBeUndefined();
  });

  it("blocks webview with empty partition", () => {
    const webPreferences: Record<string, unknown> = {};

    const result = simulateWillAttachWebview(webPreferences, {
      src: "http://localhost:3000",
      partition: "",
    });

    expect(result.prevented).toBe(true);
    expect(webPreferences.partition).toBeUndefined();
  });

  it("blocks webview with undefined partition", () => {
    const webPreferences: Record<string, unknown> = {};

    const result = simulateWillAttachWebview(webPreferences, {
      src: "http://localhost:3000",
    });

    expect(result.prevented).toBe(true);
    expect(webPreferences.partition).toBeUndefined();
  });
});
