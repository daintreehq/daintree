// @vitest-environment jsdom
/**
 * Shared video preview (#11382, #12242).
 *
 * jsdom does not decode media, so these tests pin the probe→src contract — the
 * HEAD that applies the size cap, and the daintree-media:// URL handed to the
 * element — and dispatch the error event manually rather than waiting on
 * playback. Whether ranges actually stream is a real-Chromium question these
 * cannot answer; e2e/mechanism/media-range-streaming.spec.ts is meant to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { FileVideoPreview } from "../FileVideoPreview";

const fetchMock = vi.fn();

const MEDIA_URL = "daintree-media://load/?path=%2Frepo%2Fdemo.mp4&root=%2Frepo";
const PROBE_URL = "daintree-file://load?path=%2Frepo%2Fdemo.mp4&root=%2Frepo";

/** A successful size probe: the HEAD the hook sends before mounting the element. */
function probeOk(headers: Record<string, string> = { "content-length": "2048" }) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers(headers) });
}

// jsdom neither decodes media nor tracks playback: `fireEvent.play` dispatches
// the event but leaves `paused` true and `ended` false, so a handler reading
// them off the element would see the opposite of what it was told. Set the
// state the real element would be in before firing.
function setPlaybackState(
  element: HTMLMediaElement,
  state: { paused: boolean; ended?: boolean }
): void {
  Object.defineProperty(element, "paused", { configurable: true, value: state.paused });
  Object.defineProperty(element, "ended", { configurable: true, value: state.ended ?? false });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("FileVideoPreview", () => {
  it("probes with HEAD and gives the element a daintree-media:// URL", async () => {
    probeOk();
    const { container } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" />
    );

    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    // HEAD, not GET: the probe reads Content-Length off an fd stat and must
    // never pull the body — that download is the whole thing #12242 removed.
    expect(fetchMock).toHaveBeenCalledWith(
      PROBE_URL,
      expect.objectContaining({ method: "HEAD", signal: expect.any(AbortSignal) })
    );
    const video = container.querySelector("video");
    // The scheme is the point of the change, asserted independently of how the
    // builder happens to spell the rest of the URL.
    expect(new URL(video!.getAttribute("src")!).protocol).toBe("daintree-media:");
    expect(video?.getAttribute("src")).toBe(MEDIA_URL);
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.getAttribute("controlslist")).toBe("nofullscreen");
    expect(video?.hasAttribute("disablepictureinpicture")).toBe(true);
    expect(video?.getAttribute("aria-label")).toBe("demo.mp4");
  });

  it("holds a skeleton surface while the size probe is outstanding", () => {
    // Never settles: a stat stalled on a cold or contended disk is the wait the
    // skeleton still exists for, so the surface must be an aria-busy status
    // region rather than an ungated spinner.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { container, getByRole } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" />
    );

    expect(getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector("video")).toBeNull();
  });

  it("reprobes with the cache-busting param when the reload key changes", async () => {
    probeOk();
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

  it("moves the element src when the reload key changes", async () => {
    // The bust has to reach the media URL, not just the probe: the element holds
    // the bytes it already buffered, so a src left unchanged would go on playing
    // the stale file however many times the probe re-ran.
    probeOk();
    const { rerender, container } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" reloadKey={1} />
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    expect(container.querySelector("video")?.getAttribute("src")).toBe(`${MEDIA_URL}&v=1`);

    rerender(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" reloadKey={2} />
    );

    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe(`${MEDIA_URL}&v=2`)
    );
  });

  it("releases the video element when the source is replaced, and releases the old node", async () => {
    // Without this the media loader keeps pulling bytes for a preview the user
    // has already navigated away from — the exact waste #12242 set out to end,
    // and invisible to every other test here. jsdom leaves pause()/load()
    // unimplemented, so they are spied rather than observed.
    probeOk();
    const { rerender, container } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" reloadKey={1} />
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());

    const first = container.querySelector("video")!;
    const pause = vi.fn();
    const load = vi.fn();
    first.pause = pause;
    first.load = load;

    rerender(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" reloadKey={2} />
    );

    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
    // The old node is the one reset — reading the ref in the cleanup would have
    // grabbed the replacement, silently leaving the abandoned element loading.
    expect(first.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(container.querySelector("video")!.getAttribute("src")).toBe(`${MEDIA_URL}&v=2`);
  });

  it("releases the video element on unmount", async () => {
    probeOk();
    const { container, unmount } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" />
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());

    const element = container.querySelector("video")!;
    const pause = vi.fn();
    const load = vi.fn();
    element.pause = pause;
    element.load = load;

    unmount();

    expect(pause).toHaveBeenCalledTimes(1);
    expect(element.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reports a probe failure to onError", async () => {
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
    // No specific message — callers fall back to their generic copy.
    expect(onError.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("rejects an over-cap video on the declared length, without mounting an element", async () => {
    probeOk({ "content-length": String(2 * 1024 * 1024 * 1024) });
    const onError = vi.fn();
    const { container } = render(
      <FileVideoPreview
        filePath="/repo/huge.mp4"
        rootPath="/repo"
        label="huge.mp4"
        onError={onError}
      />
    );

    // A distinct titled reason (not the callers' generic "couldn't be played"
    // copy) — the exact wording is the component's own to choose. The
    // description carries the next action so a titled surface can show both.
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.any(String), description: expect.any(String) })
      )
    );
    // Nothing is streamed for a file the viewer has already refused.
    expect(container.querySelector("video")).toBeNull();
  });

  it("mounts the video element when the probe declares no length", async () => {
    // Without a length there is nothing to measure the cap against. Streaming
    // makes that safe to allow — an unknown size costs a few ranges, not a
    // gigabyte of blob storage — so it must not be treated as a failure.
    probeOk({});
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
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not report an error when unmounted mid-probe", async () => {
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
      <FileVideoPreview
        filePath="/repo/demo.mp4"
        rootPath="/repo"
        label="demo.mp4"
        onError={onError}
      />
    );

    unmount();
    resolveFetch(undefined);
    // Flush any queued reactions before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).not.toHaveBeenCalled();
  });

  it("forwards media element errors to onError", async () => {
    probeOk();
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

  it("reports playing state through play, pause and ended", async () => {
    // The signal an owner gates its reload key on: without it, coming back to a
    // project remounts the element and drops the listener's place (#12165).
    probeOk();
    const onPlayingChange = vi.fn();
    const { container } = render(
      <FileVideoPreview
        filePath="/repo/demo.mp4"
        rootPath="/repo"
        label="demo.mp4"
        onPlayingChange={onPlayingChange}
      />
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const element = container.querySelector("video")!;

    setPlaybackState(element, { paused: false });
    fireEvent.play(element);
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);

    // Buffering drops readyState while `paused` stays false, which is why the
    // component reads paused/ended and never readiness.
    setPlaybackState(element, { paused: true });
    fireEvent.pause(element);
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);

    // The spec leaves `paused` false at the end of a track, so `ended` is the
    // only thing that says playback stopped here. Cleared first: `pause` above
    // already left `false` as the last call, so asserting on that alone would
    // stay green with the `onEnded` handler deleted outright.
    onPlayingChange.mockClear();
    setPlaybackState(element, { paused: false, ended: true });
    fireEvent.ended(element);
    expect(onPlayingChange).toHaveBeenCalledTimes(1);
    expect(onPlayingChange).toHaveBeenCalledWith(false);
  });

  it("reports a stop when the element errors mid-playback", async () => {
    // A decode failure stops playback without a `pause`. Owners that unmount on
    // error get the retraction from the cleanup anyway; one that only logs
    // would otherwise be left holding a player that stopped.
    probeOk();
    const onPlayingChange = vi.fn();
    const { container } = render(
      <FileVideoPreview
        filePath="/repo/demo.mp4"
        rootPath="/repo"
        label="demo.mp4"
        onPlayingChange={onPlayingChange}
      />
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const element = container.querySelector("video")!;
    setPlaybackState(element, { paused: false });
    fireEvent.play(element);

    onPlayingChange.mockClear();
    fireEvent.error(element);

    expect(onPlayingChange).toHaveBeenCalledWith(false);
  });

  it("reports nothing when no owner is listening", async () => {
    // DiffPane renders this leaf without the prop; an unconditional call rather
    // than optional chaining would throw the moment anyone pressed play.
    probeOk();
    const { container, unmount } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" />
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const element = container.querySelector("video")!;

    setPlaybackState(element, { paused: false });
    expect(() => {
      fireEvent.play(element);
      fireEvent.pause(element);
      fireEvent.ended(element);
      fireEvent.error(element);
      unmount();
    }).not.toThrow();
  });

  it("takes a reported play back when the source is replaced", async () => {
    // The replacement element mounts paused and fires no `pause` of its own, so
    // an owner left holding the last `true` would suppress reloads forever.
    probeOk();
    const onPlayingChange = vi.fn();
    const { container, rerender } = render(
      <FileVideoPreview
        filePath="/repo/demo.mp4"
        rootPath="/repo"
        label="demo.mp4"
        reloadKey={1}
        onPlayingChange={onPlayingChange}
      />
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const element = container.querySelector("video")!;
    setPlaybackState(element, { paused: false });
    fireEvent.play(element);
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);

    rerender(
      <FileVideoPreview
        filePath="/repo/demo.mp4"
        rootPath="/repo"
        label="demo.mp4"
        reloadKey={2}
        onPlayingChange={onPlayingChange}
      />
    );

    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
  });

  it("takes a reported play back when it unmounts", async () => {
    probeOk();
    const onPlayingChange = vi.fn();
    const { container, unmount } = render(
      <FileVideoPreview
        filePath="/repo/demo.mp4"
        rootPath="/repo"
        label="demo.mp4"
        onPlayingChange={onPlayingChange}
      />
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const element = container.querySelector("video")!;
    setPlaybackState(element, { paused: false });
    fireEvent.play(element);
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);

    unmount();

    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
  });
});
