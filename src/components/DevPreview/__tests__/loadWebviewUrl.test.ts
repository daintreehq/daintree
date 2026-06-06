import { describe, expect, it, vi } from "vitest";
import { loadWebviewUrl } from "../loadWebviewUrl";

function makeWebview(loadResult: unknown): Electron.WebviewTag {
  return {
    loadURL: vi.fn(() => loadResult),
  } as unknown as Electron.WebviewTag;
}

describe("loadWebviewUrl (#9940)", () => {
  it("calls loadURL with the target url", () => {
    const webview = makeWebview(undefined);
    loadWebviewUrl(webview, "http://localhost:5173/");
    expect(webview.loadURL).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("does not invoke onRejected when loadURL rejects with ERR_ABORTED (-3)", async () => {
    const onRejected = vi.fn();
    const webview = makeWebview(Promise.reject({ errorCode: -3 }));
    loadWebviewUrl(webview, "http://localhost:5173/", onRejected);
    await Promise.resolve();
    await Promise.resolve();
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("invokes onRejected for any non-abort rejection", async () => {
    const onRejected = vi.fn();
    const webview = makeWebview(Promise.reject({ errorCode: -105 }));
    loadWebviewUrl(webview, "http://localhost:5173/", onRejected);
    await Promise.resolve();
    await Promise.resolve();
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it("invokes onRejected when the rejection has no errorCode", async () => {
    const onRejected = vi.fn();
    const webview = makeWebview(Promise.reject(new Error("boom")));
    loadWebviewUrl(webview, "http://localhost:5173/", onRejected);
    await Promise.resolve();
    await Promise.resolve();
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it("tolerates a synchronous (non-promise) loadURL return", () => {
    const onRejected = vi.fn();
    const webview = makeWebview(undefined);
    expect(() => loadWebviewUrl(webview, "http://localhost:5173/", onRejected)).not.toThrow();
    expect(onRejected).not.toHaveBeenCalled();
  });
});
