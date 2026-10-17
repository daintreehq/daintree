// @vitest-environment jsdom
/**
 * Shared audio preview (#11425, #12242).
 *
 * jsdom does not decode media, so these tests pin the probe→src contract — the
 * HEAD that applies the size cap, and the daintree-media:// URL handed to the
 * element — and dispatch the error event manually rather than waiting on
 * playback. Whether ranges actually stream is a real-Chromium question these
 * cannot answer; e2e/mechanism/media-range-streaming.spec.ts is meant to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { FileAudioPreview } from "../FileAudioPreview";

const fetchMock = vi.fn();

const MEDIA_URL = "daintree-media://load/?path=%2Frepo%2Ftrack.mp3&root=%2Frepo";
const PROBE_URL = "daintree-file://load?path=%2Frepo%2Ftrack.mp3&root=%2Frepo";

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

describe("FileAudioPreview", () => {
  it("probes with HEAD and gives the element a daintree-media:// URL", async () => {
    probeOk();
    const { container } = render(
      <FileAudioPreview filePath="/repo/track.mp3" rootPath="/repo" label="track.mp3" />
    );

    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    // HEAD, not GET: the probe reads Content-Length off an fd stat and must
    // never pull the body — that download is the whole thing #12242 removed.
    expect(fetchMock).toHaveBeenCalledWith(
      PROBE_URL,
      expect.objectContaining({ method: "HEAD", signal: expect.any(AbortSignal) })
    );
    const audio = container.querySelector("audio");
    expect(new URL(audio!.getAttribute("src")!).protocol).toBe("daintree-media:");
    expect(audio?.getAttribute("src")).toBe(MEDIA_URL);
    expect(audio?.hasAttribute("controls")).toBe(true);
    expect(audio?.getAttribute("aria-label")).toBe("track.mp3");
  });

  it("holds a skeleton surface while the size probe is outstanding", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { container, getByRole } = render(
      <FileAudioPreview filePath="/repo/track.mp3" rootPath="/repo" label="track.mp3" />
    );

    expect(getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector("audio")).toBeNull();
  });

  it("releases the audio element when the source is replaced, and releases the old node", async () => {
    // Without this the media loader keeps pulling bytes for a preview the user
    // has already navigated away from — the exact waste #12242 set out to end,
    // and invisible to every other test here. jsdom leaves pause()/load()
    // unimplemented, so they are spied rather than observed.
    probeOk();
    const { rerender, container } = render(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        reloadKey={1}
      />
    );
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());

    const first = container.querySelector("audio")!;
    const pause = vi.fn();
    const load = vi.fn();
    first.pause = pause;
    first.load = load;

    rerender(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        reloadKey={2}
      />
    );

    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
    // The old node is the one reset — reading the ref in the cleanup would have
    // grabbed the replacement, silently leaving the abandoned element loading.
    expect(first.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(container.querySelector("audio")?.getAttribute("src")).toBe(`${MEDIA_URL}&v=2`)
    );
  });

  it("releases the audio element on unmount", async () => {
    probeOk();
    const { container, unmount } = render(
      <FileAudioPreview filePath="/repo/track.mp3" rootPath="/repo" label="track.mp3" />
    );
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());

    const element = container.querySelector("audio")!;
    const pause = vi.fn();
    const load = vi.fn();
    element.pause = pause;
    element.load = load;

    unmount();

    expect(pause).toHaveBeenCalledTimes(1);
    expect(element.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("rejects an over-cap file on the declared length, without mounting an element", async () => {
    probeOk({ "content-length": String(2 * 1024 * 1024 * 1024) });
    const onError = vi.fn();
    const { container } = render(
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
    // Nothing is streamed for a file the viewer has already refused.
    expect(container.querySelector("audio")).toBeNull();
  });

  it("forwards media element errors to onError", async () => {
    probeOk();
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

  it("reports playing state through play, pause and ended", async () => {
    // The signal an owner gates its reload key on: without it, coming back to a
    // project remounts the element and drops the listener's place (#12165).
    probeOk();
    const onPlayingChange = vi.fn();
    const { container } = render(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        onPlayingChange={onPlayingChange}
      />
    );
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    const element = container.querySelector("audio")!;

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
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        onPlayingChange={onPlayingChange}
      />
    );
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    const element = container.querySelector("audio")!;
    setPlaybackState(element, { paused: false });
    fireEvent.play(element);

    onPlayingChange.mockClear();
    fireEvent.error(element);

    expect(onPlayingChange).toHaveBeenCalledWith(false);
  });

  it("takes a reported play back when the source is replaced", async () => {
    // The replacement element mounts paused and fires no `pause` of its own, so
    // an owner left holding the last `true` would suppress reloads forever.
    probeOk();
    const onPlayingChange = vi.fn();
    const { container, rerender } = render(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        reloadKey={1}
        onPlayingChange={onPlayingChange}
      />
    );
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    const element = container.querySelector("audio")!;
    setPlaybackState(element, { paused: false });
    fireEvent.play(element);
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);

    rerender(
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
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
      <FileAudioPreview
        filePath="/repo/track.mp3"
        rootPath="/repo"
        label="track.mp3"
        onPlayingChange={onPlayingChange}
      />
    );
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    const element = container.querySelector("audio")!;
    setPlaybackState(element, { paused: false });
    fireEvent.play(element);
    expect(onPlayingChange).toHaveBeenLastCalledWith(true);

    unmount();

    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
  });
});
