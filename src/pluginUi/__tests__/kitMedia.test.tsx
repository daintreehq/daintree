// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { setPluginKitHost } from "@/components/PluginKit/kitHost";
import { PluginKitOwnerContext } from "@/components/PluginKit/kitScope";
import type { PluginArtifactSource } from "@shared/types/pluginArtifacts";

const OWNER = "acme.media";
const CLIP = { id: "a".repeat(32), mimeType: "video/mp4", name: "Launch demo" };

beforeAll(async () => {
  await kit.whenPluginUiReady();
}, 60_000);

let uninstall: (() => void) | null = null;
let hold: ((held: boolean) => void) | null;
type SourceFn = (owner: string, id: string) => Promise<PluginArtifactSource>;
let artifactSource: Mock<SourceFn>;
let releaseArtifactSource: Mock<(url: string) => void>;
let leases: number;
let pause: ReturnType<typeof vi.spyOn>;
let load: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  hold = null;
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  leases = 0;
  // Every acquisition gets its own lease, so a test can tell which was released.
  artifactSource = vi.fn<SourceFn>(async (_owner, id) => ({
    url: `daintree-media://artifact/${id}?lease=${String(++leases).padStart(48, "0")}`,
    mimeType: id === CLIP.id ? "video/mp4" : "audio/mpeg",
    size: 10,
  }));
  releaseArtifactSource = vi.fn<(url: string) => void>();
  uninstall = setPluginKitHost({
    artifactSource,
    releaseArtifactSource,
    watchPlaybackHold: (onChange) => {
      hold = onChange;
      onChange(false);
      return () => {
        hold = null;
      };
    },
  });
});

afterEach(() => {
  cleanup();
  uninstall?.();
  uninstall = null;
  vi.restoreAllMocks();
});

function inPlugin(child: ReactNode) {
  return createElement(PluginKitOwnerContext.Provider, { value: OWNER }, child);
}

async function settle() {
  await act(async () => {});
}

describe("MediaPlayer", () => {
  it("plays the view's own artifact with native controls, named, never on its own", async () => {
    const { container } = render(inPlugin(createElement(kit.MediaPlayer, { source: CLIP })));
    await settle();
    expect(artifactSource).toHaveBeenCalledWith(OWNER, CLIP.id);
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toMatch(/^daintree-media:\/\/artifact\//);
    expect(video.controls).toBe(true);
    expect(video.autoplay).toBe(false);
    expect(video.getAttribute("aria-label")).toBe("Launch demo");
    expect(video.getAttribute("preload")).toBe("metadata");
  });

  it("uses an audio element for audio", async () => {
    const { container } = render(
      inPlugin(createElement(kit.MediaPlayer, { source: "c".repeat(32), "aria-label": "Episode" }))
    );
    await settle();
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("audio")!.getAttribute("aria-label")).toBe("Episode");
  });

  it("pauses when the person moves away and doesn't resume on return", async () => {
    render(inPlugin(createElement(kit.MediaPlayer, { source: CLIP })));
    await settle();
    pause.mockClear();
    act(() => hold!(true));
    expect(pause).toHaveBeenCalledTimes(1);
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");
    act(() => hold!(false));
    expect(play).not.toHaveBeenCalled();
  });

  it("keeps playing away when asked", async () => {
    render(inPlugin(createElement(kit.MediaPlayer, { source: CLIP, whenAway: "keep-playing" })));
    await settle();
    expect(hold).toBeNull();
  });

  it("lets go of the source and its lease when it unmounts", async () => {
    const { container, unmount } = render(
      inPlugin(createElement(kit.MediaPlayer, { source: CLIP }))
    );
    await settle();
    const video = container.querySelector("video")!;
    const url = video.getAttribute("src");
    unmount();
    expect(video.getAttribute("src")).toBeNull();
    expect(load).toHaveBeenCalled();
    expect(releaseArtifactSource).toHaveBeenCalledWith(url);
  });

  it("offers Retry for a failure that asking again could mend", async () => {
    artifactSource.mockRejectedValueOnce(new Error("ARTIFACT_BUSY: too many transfers"));
    const onError = vi.fn();
    render(inPlugin(createElement(kit.MediaPlayer, { source: CLIP, onError })));
    await settle();
    expect(screen.getByText("Couldn't play this video")).toBeTruthy();
    expect(screen.getByText("The file couldn't be loaded")).toBeTruthy();
    // The plugin still gets the host's own words.
    expect(onError.mock.calls[0]![0].message).toBe("too many transfers");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(artifactSource).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn't play this video")).toBeNull();
  });

  it("says plainly why a failure Retry can't mend happened, with no Retry", async () => {
    for (const [error, words] of [
      [`ARTIFACT_NOT_FOUND: plugin "${OWNER}" has no artifact "x"`, "This file isn't available"],
      ["ARTIFACT_SOURCE_UNSUPPORTED: is text/plain", "This format can't be played here"],
      [
        "ARTIFACT_REMOTE_UNSUPPORTED: not in a remote window",
        "Media can't play in a window attached to a remote host",
      ],
    ] as const) {
      artifactSource.mockRejectedValueOnce(new Error(error));
      render(inPlugin(createElement(kit.MediaPlayer, { source: CLIP })));
      await settle();
      expect(screen.getByText(words)).toBeTruthy();
      expect(document.body.textContent).not.toContain(OWNER);
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      cleanup();
    }
  });

  it("rests on an empty state with no source, rather than loading forever", async () => {
    const { container } = render(inPlugin(createElement(kit.MediaPlayer, { source: null })));
    await settle();
    expect(artifactSource).not.toHaveBeenCalled();
    expect(container.querySelector("[data-media-empty]")?.textContent).toBe(
      "Choose audio or video to play"
    );
    expect(screen.queryByLabelText(/^Loading/)).toBeNull();
  });

  it("releases a lease that resolves after the player is gone", async () => {
    let resolve!: (source: PluginArtifactSource) => void;
    artifactSource.mockImplementationOnce(
      () => new Promise<PluginArtifactSource>((r) => (resolve = r))
    );
    const { unmount } = render(inPlugin(createElement(kit.MediaPlayer, { source: CLIP })));
    unmount();
    const late = `daintree-media://artifact/${CLIP.id}?lease=${"9".repeat(48)}`;
    await act(async () => resolve({ url: late, mimeType: "video/mp4", size: 1 }));
    expect(releaseArtifactSource).toHaveBeenCalledWith(late);
  });

  it("releases the old source's lease when the source changes", async () => {
    const { container, rerender } = render(
      inPlugin(createElement(kit.MediaPlayer, { source: CLIP }))
    );
    await settle();
    const first = container.querySelector("video")!.getAttribute("src");
    rerender(inPlugin(createElement(kit.MediaPlayer, { source: "c".repeat(32) })));
    await settle();
    expect(releaseArtifactSource).toHaveBeenCalledWith(first);
    expect(container.querySelector("audio")!.getAttribute("src")).not.toBe(first);
  });

  it("clears a playback error when a new source arrives", async () => {
    const { container, rerender } = render(
      inPlugin(createElement(kit.MediaPlayer, { source: CLIP }))
    );
    await settle();
    fireEvent.error(container.querySelector("video")!);
    expect(screen.getByText("Couldn't play this video")).toBeTruthy();
    rerender(inPlugin(createElement(kit.MediaPlayer, { source: "c".repeat(32) })));
    await settle();
    expect(screen.queryByText(/Couldn't play/)).toBeNull();
    expect(container.querySelector("audio")).not.toBeNull();
  });

  it("reports a failed source once, however often the callback changes", async () => {
    artifactSource.mockRejectedValueOnce(new Error("ARTIFACT_NOT_FOUND: gone"));
    const seen: Error[] = [];
    const { rerender } = render(
      inPlugin(createElement(kit.MediaPlayer, { source: CLIP, onError: (e) => seen.push(e) }))
    );
    await settle();
    rerender(
      inPlugin(createElement(kit.MediaPlayer, { source: CLIP, onError: (e) => seen.push(e) }))
    );
    await settle();
    expect(seen).toHaveLength(1);
  });

  it("asks nothing of the host outside a plugin view", async () => {
    render(createElement(kit.MediaPlayer, { source: CLIP }));
    await settle();
    expect(artifactSource).not.toHaveBeenCalled();
    expect(screen.getByText("Media plays only in a plugin view")).toBeTruthy();
  });
});

describe("MediaThumbnail", () => {
  it("shows an image artifact as an image, decorative unless named", async () => {
    artifactSource.mockResolvedValueOnce({
      url: `daintree-file://artifact/${"d".repeat(32)}?lease=${"b".repeat(48)}`,
      mimeType: "image/png",
      size: 1,
    });
    const { container } = render(
      inPlugin(createElement(kit.MediaThumbnail, { source: "d".repeat(32), "data-testid": "t" }))
    );
    await settle();
    expect(container.querySelector("img")!.getAttribute("src")).toMatch(/^daintree-file:/);
    expect(screen.getByTestId("t").getAttribute("aria-hidden")).toBe("true");
  });

  it("shows a video's first frame without playing it, named when given alt", async () => {
    const { container } = render(
      inPlugin(createElement(kit.MediaThumbnail, { source: CLIP, alt: "Launch demo" }))
    );
    await settle();
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toMatch(/#t=0\.1$/);
    expect(video.controls).toBe(false);
    expect(video.tabIndex).toBe(-1);
    expect(screen.getByRole("img", { name: "Launch demo" })).toBeTruthy();
  });

  it("falls back to a failed-preview glyph when an image won't decode, until a new source", async () => {
    artifactSource.mockImplementation(async (_owner, id) => ({
      url: `daintree-file://artifact/${id}?lease=${"b".repeat(48)}`,
      mimeType: "image/png",
      size: 1,
    }));
    const { container, rerender } = render(
      inPlugin(createElement(kit.MediaThumbnail, { source: "d".repeat(32) }))
    );
    await settle();
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-media-preview-failed]")).not.toBeNull();
    rerender(inPlugin(createElement(kit.MediaThumbnail, { source: "f".repeat(32) })));
    await settle();
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("shows a glyph for a type with no source and never asks for one", async () => {
    const { container } = render(
      inPlugin(
        createElement(kit.MediaThumbnail, {
          source: { id: "e".repeat(32), mimeType: "application/pdf", name: "spec.pdf" },
        })
      )
    );
    await settle();
    expect(artifactSource).not.toHaveBeenCalled();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
