// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { setPluginKitHost } from "@/components/PluginKit/kitHost";
import { PluginKitOwnerContext } from "@/components/PluginKit/kitScope";

const OWNER = "acme.media";
const CLIP = { id: "a".repeat(32), mimeType: "video/mp4", name: "Launch demo" };

beforeAll(async () => {
  await kit.whenPluginUiReady();
}, 60_000);

let uninstall: (() => void) | null = null;
let hold: ((held: boolean) => void) | null;
let artifactSource: ReturnType<typeof vi.fn>;
let releaseArtifactSource: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.spyOn>;
let load: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  hold = null;
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  artifactSource = vi.fn(async (_owner: string, id: string) => ({
    url: `daintree-media://artifact/${id}?lease=${"b".repeat(48)}`,
    mimeType: id === CLIP.id ? "video/mp4" : "audio/mpeg",
    size: 10,
  }));
  releaseArtifactSource = vi.fn();
  uninstall = setPluginKitHost({
    artifactSource: artifactSource as never,
    releaseArtifactSource: releaseArtifactSource as never,
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

  it("shows why it can't play with a Retry that asks again", async () => {
    artifactSource.mockRejectedValueOnce(new Error("ARTIFACT_NOT_FOUND: it expired"));
    const onError = vi.fn();
    render(inPlugin(createElement(kit.MediaPlayer, { source: CLIP, onError })));
    await settle();
    expect(screen.getByText("Couldn't play this video")).toBeTruthy();
    expect(screen.getByText("it expired")).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(artifactSource).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn't play this video")).toBeNull();
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
