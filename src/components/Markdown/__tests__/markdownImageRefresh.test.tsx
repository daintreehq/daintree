// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATH_CANONICAL_HEADER } from "@shared/types/ipc/files";
import type { WorktreeChangedDirs } from "@/store/createWorktreeStore";
import { TrackedMarkdownImage, type MarkdownImageTracking } from "../markdownImageRefresh";

const LOCAL_SRC = "daintree-file://load?path=%2Frepo%2Fassets%2Fb.png&root=%2Frepo";
const REMOTE_SRC =
  "daintree-file://host/box/0123456789abcdef0123456789abcdef/load?path=%2Frepo%2Fassets%2Fb.png&root=%2Frepo";

function trackingAt(at: number, dirs: readonly string[]): MarkdownImageTracking {
  const changedDirs: WorktreeChangedDirs = { at, previousAt: at - 1, dirs, run: "run-1" };
  return { trigger: at, signal: { tick: at, gitTick: 1, changedDirs }, worktreePath: "/repo" };
}

function image(src: string, tracking: MarkdownImageTracking) {
  return <TrackedMarkdownImage alt="b" src={src} epoch="0" tracking={tracking} />;
}

function srcOf(container: HTMLElement): string {
  return container.querySelector("img")?.getAttribute("src") ?? "";
}

interface PendingProbe {
  signal: AbortSignal | undefined;
  resolve: (canonical: boolean) => void;
}
const pending: PendingProbe[] = [];
const fetchMock = vi.fn(
  (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      pending.push({
        signal: init?.signal ?? undefined,
        resolve: (canonical) =>
          resolve(
            new Response(null, {
              status: 200,
              headers: { [PATH_CANONICAL_HEADER]: String(canonical) },
            })
          ),
      });
    })
);

beforeEach(() => {
  pending.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TrackedMarkdownImage", () => {
  it("scopes ticks once its path is proven, and only then", async () => {
    const view = render(image(LOCAL_SRC, trackingAt(100, ["docs"])));
    const first = srcOf(view.container);

    // Proof still in flight: an unrelated tick can't be ruled out.
    view.rerender(image(LOCAL_SRC, trackingAt(101, ["src"])));
    const second = srcOf(view.container);
    expect(second).not.toBe(first);

    await act(async () => pending.at(-1)!.resolve(true));
    view.rerender(image(LOCAL_SRC, trackingAt(102, ["src"])));
    expect(srcOf(view.container)).toBe(second);

    view.rerender(image(LOCAL_SRC, trackingAt(103, ["assets"])));
    expect(srcOf(view.container)).not.toBe(second);
  });

  it("drops a proof that lands after a later refresh superseded it", async () => {
    const view = render(image(LOCAL_SRC, trackingAt(100, ["docs"])));
    const stale = pending[0]!;

    view.rerender(image(LOCAL_SRC, trackingAt(101, ["src"])));
    expect(stale.signal?.aborted).toBe(true);
    await act(async () => stale.resolve(true));

    const before = srcOf(view.container);
    view.rerender(image(LOCAL_SRC, trackingAt(102, ["src"])));
    expect(srcOf(view.container)).not.toBe(before);
  });

  it("aborts its probe when it unmounts", () => {
    const view = render(image(LOCAL_SRC, trackingAt(100, ["docs"])));
    view.unmount();
    expect(pending[0]?.signal?.aborted).toBe(true);
  });

  it("never probes a remote view's image, which refreshes on every tick as before", () => {
    const view = render(image(REMOTE_SRC, trackingAt(100, ["docs"])));
    const first = srcOf(view.container);

    view.rerender(image(REMOTE_SRC, trackingAt(101, ["src"])));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(srcOf(view.container)).not.toBe(first);
  });

  it("asks again on a fresh mount instead of reusing an earlier mount's URL", () => {
    const first = render(image(LOCAL_SRC, trackingAt(100, ["docs"])));
    const firstSrc = srcOf(first.container);
    first.unmount();

    const second = render(image(LOCAL_SRC, trackingAt(100, ["docs"])));
    expect(srcOf(second.container)).not.toBe(firstSrc);
  });
});
