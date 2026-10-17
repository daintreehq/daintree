// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffMediaFileVersions } from "@shared/types";
import {
  ImageDiffViewer,
  describeImageFacts,
  isImageDiffCandidate,
  nextSwipePosition,
  swipeValueText,
} from "../ImageDiffViewer";

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

// Padding-free base64 payloads so jsdom returns `img.src` verbatim — the decode
// stubs below gate on the trailing token, which encoded padding could perturb.
const A_HEAD_URL = "data:image/png;base64,QUFB"; // "AAA"
const A_WORKING_URL = "data:image/png;base64,QUFC"; // "AAB"
const B_HEAD_URL = "data:image/png;base64,QUFD"; // "AAC"
const B_WORKING_URL = "data:image/png;base64,QUFE"; // "AAD"

function bothOkWith(headUrl: string, workingUrl: string): DiffMediaFileVersions {
  return {
    head: { ok: true, dataUrl: headUrl, byteSize: 4 },
    working: { ok: true, dataUrl: workingUrl, byteSize: 7 },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ImageDiffViewer", () => {
  beforeEach(() => {
    mockReadFileVersions.mockReset();
  });

  afterEach(() => {
    // Some tests install a decode stub on the shared prototype; drop it so the
    // production `typeof img.decode` guard sees jsdom's native absence again.
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  });

  it("renders both sides in two-up with the mode toggle", async () => {
    mockReadFileVersions.mockResolvedValue(bothOk());

    render(<ImageDiffViewer relPath="assets/logo.png" worktreePath="/repo" status="modified" />);

    const headImg = await screen.findByAltText("HEAD version of assets/logo.png");
    const workingImg = screen.getByAltText("Working tree version of assets/logo.png");
    expect(headImg.getAttribute("src")).toBe(HEAD_URL);
    expect(workingImg.getAttribute("src")).toBe(WORKING_URL);

    expect(screen.getByRole("radio", { name: "Two-up" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Swipe" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Onion skin" })).toBeDefined();

    expect(mockReadFileVersions).toHaveBeenCalledWith({
      cwd: "/repo",
      filePath: "assets/logo.png",
    });
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
    expect(screen.queryByRole("radio", { name: "Swipe" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Onion skin" })).toBeNull();
  });

  it("shows a single HEAD pane for a deleted file", async () => {
    mockReadFileVersions.mockResolvedValue({
      head: { ok: true, dataUrl: HEAD_URL, byteSize: 4 },
      working: { ok: false, error: "NOT_FOUND" },
    } satisfies DiffMediaFileVersions);

    render(<ImageDiffViewer relPath="gone.png" worktreePath="/repo" status="deleted" />);

    await screen.findByAltText("HEAD version of gone.png");
    expect(screen.getByText("Deleted — no working version")).toBeDefined();
    expect(screen.queryByRole("radio", { name: "Swipe" })).toBeNull();
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
    expect(screen.queryByRole("radio", { name: "Swipe" })).toBeNull();
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

  describe("layout stability while switching files (#11364)", () => {
    it("holds the previous images with no skeleton while the next file loads", async () => {
      const next = createDeferred<DiffMediaFileVersions>();
      mockReadFileVersions.mockResolvedValueOnce(bothOk()).mockReturnValueOnce(next.promise);

      const { rerender } = render(
        <ImageDiffViewer relPath="a.png" worktreePath="/repo" status="modified" />
      );
      await screen.findByAltText("HEAD version of a.png");

      // Switch to b.png — its fetch is still pending.
      rerender(<ImageDiffViewer relPath="b.png" worktreePath="/repo" status="modified" />);

      // No skeleton, and a.png's frame is still on screen (held) while b loads.
      expect(screen.queryByRole("status", { name: "Loading image versions" })).toBeNull();
      expect(screen.getByAltText("HEAD version of a.png")).toBeDefined();
      expect(screen.queryByAltText("HEAD version of b.png")).toBeNull();

      await act(async () => {
        next.resolve(bothOk());
      });
      await screen.findByAltText("HEAD version of b.png");
      expect(screen.queryByAltText("HEAD version of a.png")).toBeNull();
    });

    it("commits only the latest target when switches race, ignoring a late resolver", async () => {
      const b = createDeferred<DiffMediaFileVersions>();
      const c = createDeferred<DiffMediaFileVersions>();
      mockReadFileVersions
        .mockResolvedValueOnce(bothOkWith(A_HEAD_URL, A_WORKING_URL))
        .mockReturnValueOnce(b.promise)
        .mockReturnValueOnce(c.promise);

      const { rerender } = render(
        <ImageDiffViewer relPath="a.png" worktreePath="/repo" status="modified" />
      );
      await screen.findByAltText("HEAD version of a.png");

      rerender(<ImageDiffViewer relPath="b.png" worktreePath="/repo" status="modified" />);
      rerender(<ImageDiffViewer relPath="c.png" worktreePath="/repo" status="modified" />);

      await act(async () => {
        c.resolve(bothOkWith(A_HEAD_URL, A_WORKING_URL));
      });
      await screen.findByAltText("HEAD version of c.png");

      // The superseded b resolves late; it must not clobber c.
      await act(async () => {
        b.resolve(bothOkWith(A_HEAD_URL, A_WORKING_URL));
      });

      expect(screen.getByAltText("HEAD version of c.png")).toBeDefined();
      expect(screen.queryByAltText("HEAD version of b.png")).toBeNull();
    });

    it("holds the old frame until the new image finishes decoding, then swaps", async () => {
      const decodeGate = createDeferred<void>();
      // Gate only b.png's decodes; everything else decodes immediately.
      HTMLImageElement.prototype.decode = function (this: HTMLImageElement): Promise<void> {
        return this.src.endsWith("QUFD") || this.src.endsWith("QUFE")
          ? decodeGate.promise
          : Promise.resolve();
      };

      mockReadFileVersions
        .mockResolvedValueOnce(bothOkWith(A_HEAD_URL, A_WORKING_URL))
        .mockResolvedValueOnce(bothOkWith(B_HEAD_URL, B_WORKING_URL));

      const { rerender } = render(
        <ImageDiffViewer relPath="a.png" worktreePath="/repo" status="modified" />
      );
      await screen.findByAltText("HEAD version of a.png");

      await act(async () => {
        rerender(<ImageDiffViewer relPath="b.png" worktreePath="/repo" status="modified" />);
      });

      // b's fetch resolved but its decode is still pending → hold a, no skeleton.
      expect(screen.queryByRole("status", { name: "Loading image versions" })).toBeNull();
      expect(screen.getByAltText("HEAD version of a.png")).toBeDefined();
      expect(screen.queryByAltText("HEAD version of b.png")).toBeNull();

      await act(async () => {
        decodeGate.resolve();
      });
      await screen.findByAltText("HEAD version of b.png");
      expect(screen.queryByAltText("HEAD version of a.png")).toBeNull();
    });

    it("shows the per-side fallback when a side fails to decode, without a broken compare view", async () => {
      HTMLImageElement.prototype.decode = function (this: HTMLImageElement): Promise<void> {
        return this.src.endsWith("QUFB") ? Promise.reject(new Error("bad")) : Promise.resolve();
      };
      mockReadFileVersions.mockResolvedValue(bothOkWith(A_HEAD_URL, A_WORKING_URL));

      render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);

      // HEAD failed to decode → its pane shows the fallback; working still renders.
      expect(
        await screen.findByText("Couldn't decode this version — the file may be damaged")
      ).toBeDefined();
      expect(screen.getByAltText("Working tree version of logo.png")).toBeDefined();
      expect(screen.queryByAltText("HEAD version of logo.png")).toBeNull();
      // Compare modes are hidden while a side is un-decodable.
      expect(screen.queryByRole("radio", { name: "Swipe" })).toBeNull();
    });

    it("refetches on a status-only change and holds the old layout until the new one commits", async () => {
      const next = createDeferred<DiffMediaFileVersions>();
      mockReadFileVersions.mockResolvedValueOnce(bothOk()).mockReturnValueOnce(next.promise);

      const { rerender } = render(
        <ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />
      );
      await screen.findByAltText("Working tree version of logo.png");

      // Same path, status flips → refetch; the old two-up holds meanwhile.
      rerender(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="deleted" />);
      expect(mockReadFileVersions).toHaveBeenCalledTimes(2);
      expect(screen.getByAltText("Working tree version of logo.png")).toBeDefined();

      await act(async () => {
        next.resolve({
          head: { ok: true, dataUrl: HEAD_URL, byteSize: 4 },
          working: { ok: false, error: "NOT_FOUND" },
        });
      });
      await screen.findByText("Deleted — no working version");
      expect(screen.queryByAltText("Working tree version of logo.png")).toBeNull();
    });

    it("shows the new file's skeleton, not the previous file's error, after switching off a failed file", async () => {
      const next = createDeferred<DiffMediaFileVersions>();
      mockReadFileVersions
        .mockRejectedValueOnce(new Error("ipc down"))
        .mockReturnValueOnce(next.promise);

      const { rerender } = render(
        <ImageDiffViewer relPath="a.png" worktreePath="/repo" status="modified" />
      );
      await screen.findByText("Couldn't load image versions");

      rerender(<ImageDiffViewer relPath="b.png" worktreePath="/repo" status="modified" />);

      // b is loading with no committed content → skeleton, not a's stale error.
      expect(screen.queryByText("Couldn't load image versions")).toBeNull();
      expect(screen.getByRole("status", { name: "Loading image versions" })).toBeDefined();
    });

    it("clears a stale failure when returning to a previously-failed file that now loads", async () => {
      const aRevisit = createDeferred<DiffMediaFileVersions>();
      mockReadFileVersions
        .mockRejectedValueOnce(new Error("ipc down")) // a.png fails
        .mockResolvedValueOnce(bothOk()) // b.png ok
        .mockReturnValueOnce(aRevisit.promise); // a.png revisited, pending

      const { rerender } = render(
        <ImageDiffViewer relPath="a.png" worktreePath="/repo" status="modified" />
      );
      await screen.findByText("Couldn't load image versions");

      rerender(<ImageDiffViewer relPath="b.png" worktreePath="/repo" status="modified" />);
      await screen.findByAltText("HEAD version of b.png");

      // Return to a.png (same target key, no Retry press). The stale error must
      // not reappear; b holds while a refetches.
      rerender(<ImageDiffViewer relPath="a.png" worktreePath="/repo" status="modified" />);
      expect(screen.queryByText("Couldn't load image versions")).toBeNull();
      expect(screen.getByAltText("HEAD version of b.png")).toBeDefined();

      await act(async () => {
        aRevisit.resolve(bothOk());
      });
      await screen.findByAltText("HEAD version of a.png");
      expect(screen.queryByText("Couldn't load image versions")).toBeNull();
    });

    it("drops a resolution that lands after its decode was superseded", async () => {
      const bDecode = createDeferred<void>();
      HTMLImageElement.prototype.decode = function (this: HTMLImageElement): Promise<void> {
        // b.png's decodes hang until released; a and c decode immediately.
        return this.src.endsWith("QUFD") || this.src.endsWith("QUFE")
          ? bDecode.promise
          : Promise.resolve();
      };

      mockReadFileVersions
        .mockResolvedValueOnce(bothOkWith(A_HEAD_URL, A_WORKING_URL)) // a
        .mockResolvedValueOnce(bothOkWith(B_HEAD_URL, B_WORKING_URL)) // b: fetch ok, decode gated
        .mockResolvedValueOnce(bothOk()); // c

      const { rerender } = render(
        <ImageDiffViewer relPath="a.png" worktreePath="/repo" status="modified" />
      );
      await screen.findByAltText("HEAD version of a.png");

      // Switch to b: its fetch resolves but decode is pending — the effect is now
      // parked at the *post-decode* staleness check, not the fetch one.
      await act(async () => {
        rerender(<ImageDiffViewer relPath="b.png" worktreePath="/repo" status="modified" />);
      });

      // Switch to c and let it commit.
      rerender(<ImageDiffViewer relPath="c.png" worktreePath="/repo" status="modified" />);
      await screen.findByAltText("HEAD version of c.png");

      // Release b's decode. Its post-decode commit must be dropped — c wins.
      await act(async () => {
        bDecode.resolve();
      });
      expect(screen.getByAltText("HEAD version of c.png")).toBeDefined();
      expect(screen.queryByAltText("HEAD version of b.png")).toBeNull();
    });

    it("recovers a decode-failed pane when the same file recommits after decoding cleanly", async () => {
      let aHeadFails = true;
      HTMLImageElement.prototype.decode = function (this: HTMLImageElement): Promise<void> {
        // a.png's HEAD fails its first decode, then succeeds on the revisit.
        if (this.src.endsWith("QUFB") && aHeadFails) {
          aHeadFails = false;
          return Promise.reject(new Error("bad"));
        }
        return Promise.resolve();
      };
      mockReadFileVersions
        .mockResolvedValueOnce(bothOkWith(A_HEAD_URL, A_WORKING_URL)) // a: head decode fails, commits
        .mockReturnValueOnce(new Promise<DiffMediaFileVersions>(() => {})) // b: never commits → a stays held
        .mockResolvedValueOnce(bothOkWith(A_HEAD_URL, A_WORKING_URL)); // a again: head ok, SAME requestKey

      const { rerender } = render(
        <ImageDiffViewer relPath="a.png" worktreePath="/repo" status="modified" />
      );
      // First a: HEAD failed to decode → fallback, no HEAD img.
      expect(
        await screen.findByText("Couldn't decode this version — the file may be damaged")
      ).toBeDefined();
      expect(screen.queryByAltText("HEAD version of a.png")).toBeNull();

      // Visit b, whose fetch never commits, so a remains the committed snapshot.
      // The return recommit then reuses a's exact requestKey with NO intervening
      // commit — which is what isolates the per-attempt key from the deterministic
      // request key (a request-key-keyed pane would not remount here).
      rerender(<ImageDiffViewer relPath="b.png" worktreePath="/repo" status="modified" />);
      rerender(<ImageDiffViewer relPath="a.png" worktreePath="/repo" status="modified" />);

      await screen.findByAltText("HEAD version of a.png");
      expect(
        screen.queryByText("Couldn't decode this version — the file may be damaged")
      ).toBeNull();
    });

    it("marks the held frame aria-busy but never inert while loading, and clears it after the swap", async () => {
      const next = createDeferred<DiffMediaFileVersions>();
      mockReadFileVersions.mockResolvedValueOnce(bothOk()).mockReturnValueOnce(next.promise);

      const { container, rerender } = render(
        <ImageDiffViewer relPath="a.png" worktreePath="/repo" status="modified" />
      );
      await screen.findByAltText("HEAD version of a.png");
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();

      // Holding a while b loads → the frame is busy, but must stay interactive
      // (not inert), or a keyboard file-step would blur focus out of the dialog.
      rerender(<ImageDiffViewer relPath="b.png" worktreePath="/repo" status="modified" />);
      expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(container.querySelector("[inert]")).toBeNull();

      await act(async () => {
        next.resolve(bothOk());
      });
      await screen.findByAltText("HEAD version of b.png");
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });

    it("shows the single-pane fallback when the only side of an added file fails to decode", async () => {
      HTMLImageElement.prototype.decode = function (this: HTMLImageElement): Promise<void> {
        return this.src.endsWith("QUFC") ? Promise.reject(new Error("bad")) : Promise.resolve();
      };
      mockReadFileVersions.mockResolvedValue({
        head: { ok: false, error: "NOT_FOUND" },
        working: { ok: true, dataUrl: A_WORKING_URL, byteSize: 7 },
      } satisfies DiffMediaFileVersions);

      render(<ImageDiffViewer relPath="new.png" worktreePath="/repo" status="added" />);

      // The working side (the only visible one) failed to decode → fallback text,
      // its <img> is not rendered, and the single-pane layout is intact.
      expect(
        await screen.findByText("Couldn't decode this version — the file may be damaged")
      ).toBeDefined();
      expect(screen.queryByAltText("Working tree version of new.png")).toBeNull();
      expect(screen.getByText("Added — no previous version")).toBeDefined();
    });
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

    fireEvent.click(await screen.findByRole("radio", { name: "Onion skin" }));

    const slider = screen.getByRole("slider", { name: "Working tree opacity" });
    fireEvent.change(slider, { target: { value: "25" } });

    const workingImg = screen.getByAltText("Working tree version of logo.png");
    expect(workingImg.style.opacity).toBe("0.25");
  });
});

function ok(byteSize: number) {
  return { ok: true as const, dataUrl: "data:x", byteSize };
}

describe("swipe divider keyboard contract", () => {
  it("steps with arrows, jumps further with page keys, and reaches both ends", () => {
    const arrow = nextSwipePosition("ArrowRight", 50)!;
    const page = nextSwipePosition("PageUp", 50)!;
    expect(arrow).toBeGreaterThan(50);
    expect(page).toBeGreaterThan(arrow);
    expect(nextSwipePosition("ArrowLeft", 50)).toBeLessThan(50);
    expect(nextSwipePosition("PageDown", 50)).toBeLessThan(nextSwipePosition("ArrowLeft", 50)!);
    // Vertical arrows move the same way as the horizontal ones (APG).
    expect(nextSwipePosition("ArrowUp", 50)).toBe(arrow);
    expect(nextSwipePosition("ArrowDown", 50)).toBe(nextSwipePosition("ArrowLeft", 50));
    expect(nextSwipePosition("Home", 37)).toBe(0);
    expect(nextSwipePosition("End", 37)).toBe(100);
    expect(nextSwipePosition("Tab", 50)).toBeNull();
  });

  it("never leaves the 0–100 range", () => {
    for (const key of ["ArrowLeft", "PageDown", "ArrowDown"]) {
      expect(nextSwipePosition(key, 1)).toBe(0);
    }
    for (const key of ["ArrowRight", "PageUp", "ArrowUp"]) {
      expect(nextSwipePosition(key, 99)).toBe(100);
    }
  });

  it("names which version each end shows, and both sides in between", () => {
    expect(swipeValueText(0)).not.toBe(swipeValueText(100));
    expect(swipeValueText(0)).toMatch(/working tree/i);
    expect(swipeValueText(100)).toMatch(/HEAD/);
    const middle = swipeValueText(30);
    expect(middle).toMatch(/HEAD/);
    expect(middle).toMatch(/working tree/i);
    expect(middle).toContain("30%");
    expect(middle).toContain("70%");
  });
});

describe("describeImageFacts", () => {
  const dims = { width: 640, height: 400 };

  it("calls out a dimension change only when the size changed", () => {
    const resized = describeImageFacts(
      ok(10),
      { width: 760, height: 360 },
      {
        side: ok(10),
        dims,
      }
    );
    expect(resized).toContain("640 × 400");
    expect(resized).toContain("760 × 360");
    const same = describeImageFacts(ok(10), dims, { side: ok(10), dims });
    expect(same.match(/×/g)).toHaveLength(1);
  });

  it("signs the byte change against the baseline, and says nothing when it's unchanged", () => {
    const grew = describeImageFacts(ok(2048), dims, { side: ok(1024), dims });
    const shrank = describeImageFacts(ok(1024), dims, { side: ok(2048), dims });
    expect(grew).toMatch(/\(\+/);
    expect(shrank).toMatch(/\(−/);
    expect(describeImageFacts(ok(1024), dims, { side: ok(1024), dims })).not.toMatch(/[(]/);
    // HEAD has no baseline, so it never carries a delta.
    expect(describeImageFacts(ok(2048), dims)).not.toMatch(/[(]/);
  });
});

describe("ImageDiffViewer comparison", () => {
  // Padding-free payloads, so jsdom returns `img.src` verbatim and the natural-size
  // stubs below can key on it.
  const HEAD_URL = "data:image/png;base64,SEVBRA";
  const WORKING_URL = "data:image/png;base64,V09SSw";

  function versions(): DiffMediaFileVersions {
    return {
      head: { ok: true, dataUrl: HEAD_URL, byteSize: 1000 },
      working: { ok: true, dataUrl: WORKING_URL, byteSize: 1500 },
    };
  }

  beforeEach(() => {
    mockReadFileVersions.mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  });

  it("clips HEAD and the working tree to complementary halves at every divider position", async () => {
    mockReadFileVersions.mockResolvedValue(versions());
    render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
    fireEvent.click(await screen.findByRole("radio", { name: "Swipe" }));
    const divider = screen.getByRole("slider", { name: "Swipe divider" });

    const insets = () => {
      const clip = (alt: string) => screen.getByAltText(alt).parentElement?.style.clipPath ?? "";
      const head = clip("HEAD version of logo.png").match(/inset\(0(?:px)? ([\d.]+)%/);
      const working = clip("Working tree version of logo.png").match(/([\d.]+)%\)$/);
      return { headRight: Number(head?.[1]), workingLeft: Number(working?.[1]) };
    };

    for (const key of [null, "PageUp", "End", "Home", "ArrowRight"]) {
      if (key) fireEvent.keyDown(divider, { key });
      const { headRight, workingLeft } = insets();
      // Whatever HEAD hides, the working tree shows, and nothing is shown twice.
      expect(headRight + workingLeft).toBe(100);
      expect(workingLeft).toBe(Number(divider.getAttribute("aria-valuenow")));
    }
  });

  it("describes the divider position for assistive tech as it moves", async () => {
    mockReadFileVersions.mockResolvedValue(versions());
    render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
    fireEvent.click(await screen.findByRole("radio", { name: "Swipe" }));
    const divider = screen.getByRole("slider", { name: "Swipe divider" });
    const before = divider.getAttribute("aria-valuetext");
    fireEvent.keyDown(divider, { key: "End" });
    expect(divider.getAttribute("aria-valuenow")).toBe("100");
    expect(divider.getAttribute("aria-valuetext")).toBe(swipeValueText(100));
    expect(divider.getAttribute("aria-valuetext")).not.toBe(before);
  });

  it("explains two limit failures per side instead of offering a Retry that can't help", async () => {
    mockReadFileVersions.mockResolvedValue({
      head: { ok: false, error: "TOO_LARGE" },
      working: { ok: false, error: "UNSUPPORTED" },
    } satisfies DiffMediaFileVersions);
    render(<ImageDiffViewer relPath="huge.png" worktreePath="/repo" status="modified" />);

    expect(await screen.findByText(/too large/i)).toBeDefined();
    expect(screen.getByText(/can't be previewed/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers Retry on a transiently failed side in two-up", async () => {
    mockReadFileVersions.mockResolvedValue({
      head: { ok: false, error: "ERROR" },
      working: { ok: true, dataUrl: WORKING_URL, byteSize: 7 },
    } satisfies DiffMediaFileVersions);
    render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(mockReadFileVersions).toHaveBeenCalledTimes(2);
  });

  describe("with measured frames and known natural sizes", () => {
    const NATURAL: Record<string, { w: number; h: number }> = {
      [HEAD_URL]: { w: 640, h: 400 },
      [WORKING_URL]: { w: 760, h: 360 },
    };

    // Assigned rather than `vi.stubGlobal`ed: unstubbing would also strip the
    // setup file's own ResizeObserver/rAF stubs, which later tests rely on.
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalRaf = globalThis.requestAnimationFrame;

    beforeEach(() => {
      HTMLImageElement.prototype.decode = () => Promise.resolve();
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockImplementation(function (
        this: HTMLImageElement
      ) {
        return NATURAL[this.src]?.w ?? 0;
      });
      vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockImplementation(function (
        this: HTMLImageElement
      ) {
        return NATURAL[this.src]?.h ?? 0;
      });
      // Every observed frame measures 300×200 — smaller than either image.
      globalThis.ResizeObserver = class {
        constructor(private cb: ResizeObserverCallback) {}
        observe(target: Element) {
          this.cb(
            [{ target, contentRect: { width: 300, height: 200 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver
          );
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
      globalThis.requestAnimationFrame = (fn: FrameRequestCallback) => {
        fn(0);
        return 1;
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
      globalThis.ResizeObserver = originalResizeObserver;
      globalThis.requestAnimationFrame = originalRaf;
    });

    const renderedWidth = (alt: string) => parseFloat(screen.getByAltText(alt).style.width);

    it.each(["Two-up", "Swipe", "Onion skin"])(
      "draws both versions at one shared scale in %s",
      async (mode) => {
        mockReadFileVersions.mockResolvedValue(versions());
        render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
        fireEvent.click(await screen.findByRole("radio", { name: mode }));

        const head = renderedWidth("HEAD version of logo.png");
        const working = renderedWidth("Working tree version of logo.png");
        expect(head).toBeGreaterThan(0);
        // Same scale ⇒ the rendered widths keep the natural widths' ratio,
        // so a wider working tree still looks wider.
        expect(working / head).toBeCloseTo(760 / 640, 1);
        expect(working).toBeLessThanOrEqual(300);
      }
    );

    it.each(["Two-up", "Swipe", "Onion skin"])(
      "draws both versions at their natural size at 100%% in %s",
      async (mode) => {
        mockReadFileVersions.mockResolvedValue(versions());
        render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
        fireEvent.click(await screen.findByRole("radio", { name: mode }));
        fireEvent.click(screen.getByRole("radio", { name: "Actual size" }));

        expect(renderedWidth("HEAD version of logo.png")).toBe(NATURAL[HEAD_URL]!.w);
        expect(renderedWidth("Working tree version of logo.png")).toBe(NATURAL[WORKING_URL]!.w);
        fireEvent.click(screen.getByRole("radio", { name: "Fit to screen" }));
        expect(renderedWidth("Working tree version of logo.png")).toBeLessThanOrEqual(300);
      }
    );

    it("gives both two-up panes the same canvas, so differently sized versions line up", async () => {
      mockReadFileVersions.mockResolvedValue(versions());
      render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
      await screen.findByRole("radio", { name: "Swipe" });

      const canvasOf = (alt: string) => screen.getByAltText(alt).parentElement!;
      for (const zoom of ["Fit to screen", "Actual size"]) {
        fireEvent.click(screen.getByRole("radio", { name: zoom }));
        const head = canvasOf("HEAD version of logo.png");
        const working = canvasOf("Working tree version of logo.png");
        expect(head.style.width).not.toBe("");
        expect(head.style.width).toBe(working.style.width);
        expect(head.style.height).toBe(working.style.height);
      }
    });

    it("keeps both two-up panes on the same region when one scrolls at 100%", async () => {
      mockReadFileVersions.mockResolvedValue(versions());
      render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
      fireEvent.click(await screen.findByRole("radio", { name: "Actual size" }));

      const frameOf = (alt: string) =>
        screen.getByAltText(alt).closest<HTMLElement>("[data-image-frame]")!;
      const head = frameOf("HEAD version of logo.png");
      const working = frameOf("Working tree version of logo.png");
      head.scrollLeft = 120;
      head.scrollTop = 45;
      fireEvent.scroll(head);
      expect(working.scrollLeft).toBe(head.scrollLeft);
      expect(working.scrollTop).toBe(head.scrollTop);
      working.scrollLeft = 7;
      fireEvent.scroll(working);
      expect(head.scrollLeft).toBe(working.scrollLeft);
    });

    it("never upscales an image smaller than its frame", async () => {
      NATURAL[HEAD_URL] = { w: 64, h: 40 };
      NATURAL[WORKING_URL] = { w: 64, h: 40 };
      try {
        mockReadFileVersions.mockResolvedValue(versions());
        render(<ImageDiffViewer relPath="logo.png" worktreePath="/repo" status="modified" />);
        await screen.findByRole("radio", { name: "Swipe" });
        expect(renderedWidth("HEAD version of logo.png")).toBe(64);
        // Everything already shows at actual size, so 100% would change nothing.
        expect(screen.getByRole("radio", { name: "Actual size" }).hasAttribute("disabled")).toBe(
          true
        );
      } finally {
        NATURAL[HEAD_URL] = { w: 640, h: 400 };
        NATURAL[WORKING_URL] = { w: 760, h: 360 };
      }
    });
  });
});
