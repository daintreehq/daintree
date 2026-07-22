// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffMediaFileVersions } from "@shared/types";
import { ImageDiffViewer, isImageDiffCandidate } from "../ImageDiffViewer";

const mockReadFileVersions = vi.fn();
vi.mock("@/clients/diffMediaClient", () => ({
  diffMediaClient: {
    readFileVersions: (...args: unknown[]) => mockReadFileVersions(...args),
  },
}));

const HEAD_URL = "data:image/png;base64,aGVhZA==";
const WORKING_URL = "data:image/png;base64,d29ya2luZw==";

function bothOk(): DiffMediaFileVersions {
  return {
    head: { ok: true, dataUrl: HEAD_URL, byteSize: 4 },
    working: { ok: true, dataUrl: WORKING_URL, byteSize: 7 },
  };
}

describe("ImageDiffViewer", () => {
  beforeEach(() => {
    mockReadFileVersions.mockReset();
  });

  it("renders both sides in two-up with the mode toggle", async () => {
    mockReadFileVersions.mockResolvedValue(bothOk());

    render(<ImageDiffViewer relPath="assets/logo.png" worktreePath="/repo" status="modified" />);

    const headImg = await screen.findByAltText("HEAD version of assets/logo.png");
    const workingImg = screen.getByAltText("Working tree version of assets/logo.png");
    expect(headImg.getAttribute("src")).toBe(HEAD_URL);
    expect(workingImg.getAttribute("src")).toBe(WORKING_URL);

    expect(screen.getByRole("button", { name: "Two-up" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Swipe" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Onion skin" })).toBeDefined();

    expect(mockReadFileVersions).toHaveBeenCalledWith({
      cwd: "/repo",
      filePath: "assets/logo.png",
    });
  });

  it("switches to swipe mode with a keyboard-adjustable divider", async () => {
    mockReadFileVersions.mockResolvedValue(bothOk());

    render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);

    fireEvent.click(await screen.findByRole("button", { name: "Swipe" }));

    const divider = screen.getByRole("slider", { name: "Swipe divider" });
    expect(divider.getAttribute("aria-valuenow")).toBe("50");

    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider.getAttribute("aria-valuenow")).toBe("52");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider.getAttribute("aria-valuenow")).toBe("48");
  });

  it("shows a single working-tree pane for an added file and hides compare modes", async () => {
    mockReadFileVersions.mockResolvedValue({
      head: { ok: false, error: "NOT_FOUND" },
      working: { ok: true, dataUrl: WORKING_URL, byteSize: 7 },
    } satisfies DiffMediaFileVersions);

    render(<ImageDiffViewer relPath="new.png" worktreePath="/repo" status="added" />);

    await screen.findByAltText("Working tree version of new.png");
    expect(screen.queryByAltText("HEAD version of new.png")).toBeNull();
    expect(screen.getByText("Added — no previous version")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Swipe" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Onion skin" })).toBeNull();
  });

  it("shows a single HEAD pane for a deleted file", async () => {
    mockReadFileVersions.mockResolvedValue({
      head: { ok: true, dataUrl: HEAD_URL, byteSize: 4 },
      working: { ok: false, error: "NOT_FOUND" },
    } satisfies DiffMediaFileVersions);

    render(<ImageDiffViewer relPath="gone.png" worktreePath="/repo" status="deleted" />);

    await screen.findByAltText("HEAD version of gone.png");
    expect(screen.getByText("Deleted — no working version")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Swipe" })).toBeNull();
  });

  it("keeps the single-pane layout for a deleted file with no readable prior version", async () => {
    mockReadFileVersions.mockResolvedValue({
      head: { ok: false, error: "NOT_FOUND" },
      working: { ok: false, error: "NOT_FOUND" },
    } satisfies DiffMediaFileVersions);

    render(<ImageDiffViewer relPath="gone.png" worktreePath="/repo" status="deleted" />);

    expect(await screen.findByText("Deleted — no working version")).toBeDefined();
    expect(screen.getByText("No version to show")).toBeDefined();
    expect(screen.queryByText("Couldn't load image versions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers Retry in the deleted-file pane after a transient HEAD failure", async () => {
    mockReadFileVersions.mockResolvedValueOnce({
      head: { ok: false, error: "ERROR" },
      working: { ok: false, error: "NOT_FOUND" },
    } satisfies DiffMediaFileVersions);
    mockReadFileVersions.mockResolvedValueOnce({
      head: { ok: true, dataUrl: HEAD_URL, byteSize: 4 },
      working: { ok: false, error: "NOT_FOUND" },
    } satisfies DiffMediaFileVersions);

    render(<ImageDiffViewer relPath="gone.png" worktreePath="/repo" status="deleted" />);

    expect(await screen.findByText("Couldn't load this version")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByAltText("HEAD version of gone.png");
    expect(mockReadFileVersions).toHaveBeenCalledTimes(2);
  });

  it("shows a per-side message and hides compare modes when one side is too large", async () => {
    mockReadFileVersions.mockResolvedValue({
      head: { ok: false, error: "TOO_LARGE" },
      working: { ok: true, dataUrl: WORKING_URL, byteSize: 7 },
    } satisfies DiffMediaFileVersions);

    render(<ImageDiffViewer relPath="huge.png" worktreePath="/repo" status="modified" />);

    expect(await screen.findByText("Image too large to compare (over 8 MB)")).toBeDefined();
    expect(screen.getByAltText("Working tree version of huge.png")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Swipe" })).toBeNull();
  });

  it("recovers via Retry after a failed fetch", async () => {
    mockReadFileVersions.mockRejectedValueOnce(new Error("ipc down"));
    mockReadFileVersions.mockResolvedValueOnce(bothOk());

    render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);

    const retryButton = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);

    await screen.findByAltText("HEAD version of logo.png");
    expect(mockReadFileVersions).toHaveBeenCalledTimes(2);
  });

  it("treats a double-sided failure like a fetch failure", async () => {
    mockReadFileVersions.mockResolvedValue({
      head: { ok: false, error: "ERROR" },
      working: { ok: false, error: "ERROR" },
    } satisfies DiffMediaFileVersions);

    render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);

    expect(await screen.findByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows the loading skeleton while the fetch is pending", () => {
    mockReadFileVersions.mockReturnValue(new Promise(() => {}));

    render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);

    expect(screen.getByRole("status", { name: "Loading image versions" })).toBeDefined();
  });

  describe("isImageDiffCandidate", () => {
    it("accepts every supported image extension case-insensitively", () => {
      for (const path of [
        "a.png",
        "b.jpg",
        "c.JPEG",
        "d.gif",
        "e.webp",
        "f.bmp",
        "g.ico",
        "nested/dir/h.SVG",
      ]) {
        expect(isImageDiffCandidate(path)).toBe(true);
      }
    });

    it("rejects non-image paths and lookalikes", () => {
      for (const path of ["a.ts", "png", "archive.png.zip", "no-extension", "svg/readme.md"]) {
        expect(isImageDiffCandidate(path)).toBe(false);
      }
    });
  });

  it("waits for the two-up mode toggle before allowing onion skin", async () => {
    mockReadFileVersions.mockResolvedValue(bothOk());

    render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);

    fireEvent.click(await screen.findByRole("button", { name: "Onion skin" }));

    const slider = screen.getByRole("slider", { name: "Working tree opacity" });
    fireEvent.change(slider, { target: { value: "25" } });

    const workingImg = screen.getByAltText("Working tree version of logo.png");
    expect(workingImg.style.opacity).toBe("0.25");
  });
});
