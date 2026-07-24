// @vitest-environment jsdom
/**
 * Shared video preview (#11382).
 *
 * jsdom does not decode media, so these tests pin the fetch→blob→object-URL
 * contract — Chromium's custom-scheme media loader can't consume follow-up
 * range requests (electron#51442), so the component must never point the
 * <video> at daintree-file:// directly — and dispatch the error event manually
 * rather than waiting on playback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { FileVideoPreview, VIDEO_TOO_LARGE_MESSAGE } from "../FileVideoPreview";

const fetchMock = vi.fn();
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

function respondWith(blob: Blob, headers: Record<string, string> = {}) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(headers),
    blob: () => Promise.resolve(blob),
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  let nextUrl = 0;
  createObjectURL.mockImplementation(() => `blob:app://daintree/${nextUrl++}`);
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  createObjectURL.mockReset();
  revokeObjectURL.mockReset();
});

describe("FileVideoPreview", () => {
  it("fetches from the daintree-file protocol and plays through a blob object URL", async () => {
    respondWith(new Blob(["x"]));
    const { container } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" />
    );

    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      "daintree-file://load?path=%2Frepo%2Fdemo.mp4&root=%2Frepo",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toMatch(/^blob:/);
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.getAttribute("controlslist")).toBe("nofullscreen");
    expect(video?.hasAttribute("disablepictureinpicture")).toBe(true);
    expect(video?.getAttribute("aria-label")).toBe("demo.mp4");
  });

  it("refetches with the cache-busting param when the reload key changes", async () => {
    respondWith(new Blob(["x"]));
    const { rerender, container } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" reloadKey={1} />
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    expect(fetchMock.mock.calls[0]?.[0]).toContain("&v=1");

    rerender(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" reloadKey={2} />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toContain("&v=2");
  });

  it("revokes the object URL when the source changes", async () => {
    respondWith(new Blob(["x"]));
    const { rerender, container } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" reloadKey={1} />
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const firstUrl = container.querySelector("video")?.getAttribute("src");

    rerender(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" reloadKey={2} />
    );

    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl));
  });

  it("reports a fetch failure to onError", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const onError = vi.fn();
    render(
      <FileVideoPreview
        filePath="/repo/demo.mp4"
        rootPath="/repo"
        label="demo.mp4"
        onError={onError}
      />
    );

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith();
  });

  it("rejects an over-cap video by declared length without reading the body", async () => {
    const blob = { size: 1 } as Blob;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(2 * 1024 * 1024 * 1024) }),
      blob: () => Promise.resolve(blob),
    });
    const onError = vi.fn();
    render(
      <FileVideoPreview
        filePath="/repo/huge.mp4"
        rootPath="/repo"
        label="huge.mp4"
        onError={onError}
      />
    );

    await waitFor(() => expect(onError).toHaveBeenCalledWith(VIDEO_TOO_LARGE_MESSAGE));
  });

  it("forwards media element errors to onError", async () => {
    respondWith(new Blob(["x"]));
    const onError = vi.fn();
    const { container } = render(
      <FileVideoPreview
        filePath="/repo/demo.mp4"
        rootPath="/repo"
        label="demo.mp4"
        onError={onError}
      />
    );

    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    fireEvent.error(container.querySelector("video")!);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
