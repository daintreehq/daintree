// @vitest-environment jsdom
/**
 * Shared audio preview (#11425).
 *
 * jsdom does not decode media, so these tests pin the fetch→blob→object-URL
 * contract — Chromium's custom-scheme media loader can't consume follow-up
 * range requests (electron#51442), so the component must never point the
 * <audio> at daintree-file:// directly — and dispatch the error event manually
 * rather than waiting on playback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { FileAudioPreview } from "../FileAudioPreview";

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

describe("FileAudioPreview", () => {
  it("fetches from the daintree-file protocol and plays through a blob object URL", async () => {
    respondWith(new Blob(["x"]));
    const { container } = render(
      <FileAudioPreview filePath="/repo/track.mp3" rootPath="/repo" label="track.mp3" />
    );

    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      "daintree-file://load?path=%2Frepo%2Ftrack.mp3&root=%2Frepo",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const audio = container.querySelector("audio");
    expect(audio?.getAttribute("src")).toMatch(/^blob:/);
    expect(audio?.hasAttribute("controls")).toBe(true);
    expect(audio?.getAttribute("aria-label")).toBe("track.mp3");
  });

  it("holds a skeleton surface while the whole file downloads", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { container, getByRole } = render(
      <FileAudioPreview filePath="/repo/track.mp3" rootPath="/repo" label="track.mp3" />
    );

    expect(getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector("audio")).toBeNull();
  });

  it("refetches with the cache-busting param when the reload key changes", async () => {
    respondWith(new Blob(["x"]));
    const { rerender, container } = render(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        reloadKey={1}
      />
    );
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    expect(fetchMock.mock.calls[0]?.[0]).toContain("&v=1");

    rerender(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        reloadKey={2}
      />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toContain("&v=2");
  });

  it("revokes the object URL when the source changes", async () => {
    respondWith(new Blob(["x"]));
    const { rerender, container } = render(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        reloadKey={1}
      />
    );
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    const firstUrl = container.querySelector("audio")?.getAttribute("src");

    rerender(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        reloadKey={2}
      />
    );

    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl));
  });

  it("reports a fetch failure to onError without naming a reason", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const onError = vi.fn();
    render(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        onError={onError}
      />
    );

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    // No specific message — callers fall back to their generic copy.
    expect(onError.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("rejects an over-cap file by declared length without reading the body", async () => {
    const blobSpy = vi.fn(() => Promise.resolve(new Blob(["x"])));
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(2 * 1024 * 1024 * 1024) }),
      blob: blobSpy,
    });
    const onError = vi.fn();
    render(
      <FileAudioPreview
        filePath="/repo/huge.wav"
        rootPath="/repo"
        label="huge.wav"
        onError={onError}
      />
    );

    // A distinct titled reason (not the callers' generic "couldn't be played"
    // copy), with the description carrying the next action.
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.any(String),
          description: expect.any(String),
          code: "FILE_TOO_LARGE",
        })
      )
    );
    expect(blobSpy).not.toHaveBeenCalled();
  });

  it("rejects an over-cap file by blob size when no length was declared", async () => {
    const oversized = new Blob(["x"]);
    Object.defineProperty(oversized, "size", { value: 2 * 1024 * 1024 * 1024 });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () => Promise.resolve(oversized),
    });
    const onError = vi.fn();
    render(
      <FileAudioPreview
        filePath="/repo/huge.wav"
        rootPath="/repo"
        label="huge.wav"
        onError={onError}
      />
    );

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ title: expect.any(String) }))
    );
  });

  it("does not report an error when unmounted mid-fetch", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          resolveFetch = resolve;
          opts.signal.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        })
    );
    const onError = vi.fn();
    const { unmount } = render(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        onError={onError}
      />
    );

    unmount();
    resolveFetch(undefined);
    // Flush any queued reactions before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("forwards media element errors to onError", async () => {
    respondWith(new Blob(["x"]));
    const onError = vi.fn();
    const { container } = render(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        onError={onError}
      />
    );

    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    fireEvent.error(container.querySelector("audio")!);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
