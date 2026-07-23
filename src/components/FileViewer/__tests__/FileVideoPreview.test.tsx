// @vitest-environment jsdom
/**
 * Shared video preview (#11382).
 *
 * jsdom does not decode media, so these tests pin the element contract — the
 * protocol URL, native controls, metadata-only preload, reload semantics — and
 * dispatch the error event manually rather than waiting on playback.
 */
import { describe, it, expect, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { afterEach } from "vitest";
import { FileVideoPreview } from "../FileVideoPreview";

afterEach(cleanup);

describe("FileVideoPreview", () => {
  it("renders a native-controls video sourced from the daintree-file protocol", () => {
    const { container } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" />
    );

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe(
      "daintree-file://load?path=%2Frepo%2Fdemo.mp4&root=%2Frepo"
    );
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.getAttribute("preload")).toBe("metadata");
    expect(video?.getAttribute("aria-label")).toBe("demo.mp4");
  });

  it("appends the reload key as a cache-busting param", () => {
    const { container } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" reloadKey={3} />
    );

    expect(container.querySelector("video")?.getAttribute("src")).toContain("&v=3");
  });

  it("changes src when the reload key changes, forcing a fresh media request", () => {
    const { container, rerender } = render(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" reloadKey={1} />
    );
    const before = container.querySelector("video")?.getAttribute("src");

    rerender(
      <FileVideoPreview filePath="/repo/demo.mp4" rootPath="/repo" label="demo.mp4" reloadKey={2} />
    );
    const after = container.querySelector("video")?.getAttribute("src");

    expect(before).not.toBe(after);
  });

  it("forwards media errors to onError", () => {
    const onError = vi.fn();
    const { container } = render(
      <FileVideoPreview
        filePath="/repo/demo.mp4"
        rootPath="/repo"
        label="demo.mp4"
        onError={onError}
      />
    );

    fireEvent.error(container.querySelector("video")!);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
