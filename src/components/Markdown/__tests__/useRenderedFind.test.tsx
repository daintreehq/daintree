// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRenderedFind } from "../useRenderedFind";
import { restoreFindHighlights, sole, stubFindHighlights } from "./findHighlightStub";

function documentWith(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

/** Passes over the document's text. jsdom's selector engine makes walkers too, without a filter. */
function countTextWalks(): () => number {
  const walkers = vi.spyOn(document, "createTreeWalker");
  return () => walkers.mock.calls.filter((call) => call[2] != null).length;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// The observer's records arrive in a microtask.
const delivered = () => act(() => new Promise<void>((resolve) => queueMicrotask(resolve)));

/** Holds animation frames until the test runs them, so a queued refresh can be seen. */
function holdFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(nextId, callback);
    return nextId++;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  return {
    pending: () => frames.size,
    run() {
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(0);
    },
  };
}

/** The observers the hook starts, in order, so each can be checked for disconnection. */
function watchObservers() {
  const observe = vi.spyOn(MutationObserver.prototype, "observe");
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  return {
    all: () => observe.mock.contexts as MutationObserver[],
    connected: (observer: MutationObserver | undefined) =>
      observer !== undefined && !disconnect.mock.contexts.includes(observer),
  };
}

afterEach(() => {
  try {
    vi.restoreAllMocks();
    cleanup();
    // `close()` selects the last match.
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  } finally {
    restoreFindHighlights();
  }
});

describe("useRenderedFind", () => {
  // A close that lands between a refresh's commit and its paint effect: React
  // runs that paint after `close()` has cleared, so only the closed render's
  // clear leaves the document unpainted.
  it("leaves nothing painted when the bar closes before a refresh has painted", async () => {
    const highlights = stubFindHighlights();
    const root = document.createElement("div");
    root.innerHTML = "<p>store store</p>";
    document.body.append(root);
    const closeOnCommit = { armed: false };
    const { result } = renderHook(() => {
      const find = useRenderedFind(root);
      useLayoutEffect(() => {
        // Only the refresh commit, the one that sees the appended match.
        if (closeOnCommit.armed && find.isOpen && find.matchCount === 3) {
          closeOnCommit.armed = false;
          find.close();
        }
      });
      return find;
    });
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));
    expect(highlights.matches().size + highlights.current().size).toBe(2);

    closeOnCommit.armed = true;
    act(() => root.querySelector("p")!.append(" store"));

    await waitFor(() => expect(result.current.isOpen).toBe(false));
    expect(closeOnCommit.armed).toBe(false);
    expect(highlights.matches().size + highlights.current().size).toBe(0);
  });

  // Each committed edit used to walk the whole document again (#17789).
  it("indexes a stable document once while a query is typed", () => {
    stubFindHighlights();
    const root = documentWith(
      Array.from(
        { length: 200 },
        (_, i) => `<p>Block ${i} keeps a <em>${i % 2 ? "Store" : "store"}</em> here</p>`
      ).join("")
    );
    const textWalks = countTextWalks();
    const { result } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    const counts = ["s", "st", "sto", "stor", "store", "stores", "store"].map((query) => {
      act(() => result.current.setQuery(query));
      return result.current.matchCount;
    });
    // "s" is in "keeps" and "store"; "st" only in "store".
    expect(counts).toEqual([400, 200, 200, 200, 200, 0, 200]);
    act(() => result.current.toggleMatchCase());
    expect(result.current.matchCount).toBe(100);
    expect(textWalks()).toBe(1);
  });

  it("searches a composed query once it commits, against the same index", async () => {
    stubFindHighlights();
    const root = documentWith("<p>店舗 store</p><p>店舗</p>");
    const textWalks = countTextWalks();
    const { result } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));
    expect(result.current.matchCount).toBe(1);

    act(() => result.current.startComposition());
    act(() => result.current.setQuery("て"));
    expect(result.current.query).toBe("て");
    // A live edit mid-composition refreshes nothing: the draft is not a query yet.
    act(() => root.querySelector("p")!.append(" て"));
    await act(nextFrame);
    expect(result.current.matchCount).toBe(1);
    expect(textWalks()).toBe(1);

    act(() => result.current.endComposition("店舗"));
    expect(result.current.matchCount).toBe(2);
    expect(textWalks()).toBe(2);
  });

  it("follows live edits to the document under the open bar, one refresh a frame", async () => {
    stubFindHighlights();
    const frames = holdFrames();
    const root = documentWith("<p>store</p>");
    const textWalks = countTextWalks();
    const { result } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));
    expect(result.current.matchCount).toBe(1);

    act(() => root.querySelector("p")!.append(" store"));
    await delivered();
    act(() => root.querySelector("p")!.append(" store"));
    await delivered();
    expect(frames.pending()).toBe(1);
    expect(result.current.matchCount).toBe(1);

    act(() => frames.run());
    expect(result.current.matchCount).toBe(3);
    act(() => result.current.setQuery("stores"));
    expect(result.current.matchCount).toBe(0);
    act(() => result.current.setQuery("store"));
    expect(result.current.matchCount).toBe(3);
    expect(textWalks()).toBe(2);
  });

  // A refresh queued before an explicit search would otherwise run with the
  // query last committed, and could land its matches over the new query's.
  it("drops a queued refresh once a new search has read the document", async () => {
    stubFindHighlights();
    const frames = holdFrames();
    const root = documentWith("<p>store state</p>");
    const { result } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));

    act(() => root.querySelector("p")!.append(" store"));
    await delivered();
    expect(frames.pending()).toBe(1);
    act(() => {
      result.current.setQuery("state");
      // Same frame, before React commits the new query.
      frames.run();
    });
    expect(result.current.query).toBe("state");
    expect(result.current.matchCount).toBe(1);
  });

  it("follows highlighted code replacing a block's text with the same text in spans", async () => {
    const highlights = stubFindHighlights();
    const root = documentWith("<pre><code>const usePanelStore = create();</code></pre>");
    const code = root.querySelector("code")!;
    const { result } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    act(() => result.current.setQuery("usePanelStore"));
    expect(sole(highlights.current())!.startContainer).toBe(code.firstChild);

    act(() => {
      code.innerHTML = '<span class="k">const</span> use<span>PanelStore</span> = create();';
    });
    await waitFor(() =>
      expect(sole(highlights.current())!.endContainer).toBe(
        code.querySelectorAll("span")[1]!.firstChild
      )
    );
    const range = sole(highlights.current())!;
    expect(range.startContainer.isConnected).toBe(true);
    expect([range.startOffset, range.endOffset]).toEqual([1, 10]);
    expect(range.toString()).toBe("usePanelStore");
  });

  it("drops matches that become hidden and paints them again, with the query held", async () => {
    const highlights = stubFindHighlights();
    const root = documentWith("<p>store <span>store</span></p>");
    const span = root.querySelector("span")!;
    const painted = () =>
      [...highlights.matches(), ...highlights.current()].map((range) => range.startContainer);
    const { result } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));
    expect(painted()).toHaveLength(2);

    act(() => span.setAttribute("aria-hidden", "true"));
    await waitFor(() => expect(result.current.matchCount).toBe(1));
    expect(painted()).toEqual([root.querySelector("p")!.firstChild]);
    act(() => span.removeAttribute("aria-hidden"));
    await waitFor(() => expect(result.current.matchCount).toBe(2));
    expect(painted()).toContain(span.firstChild);
  });

  it("lets go of the index as it closes and builds a fresh one on reopen", () => {
    stubFindHighlights();
    const root = documentWith("<p>store</p>");
    const observers = watchObservers();
    const textWalks = countTextWalks();
    const { result } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));
    expect(observers.all()).toHaveLength(1);
    const [observer] = observers.all();
    expect(observers.connected(observer)).toBe(true);

    let connectedAfterClose = true;
    act(() => {
      result.current.close();
      // Before React commits the close and runs any cleanup.
      connectedAfterClose = observers.connected(observer);
    });
    expect(connectedAfterClose).toBe(false);

    root.querySelector("p")!.append(" store");
    act(() => result.current.open());
    expect(result.current.matchCount).toBe(2);
    expect(textWalks()).toBe(2);
  });

  it("cancels a queued refresh when it unmounts", async () => {
    stubFindHighlights();
    const frames = holdFrames();
    const root = documentWith("<p>store</p>");
    const textWalks = countTextWalks();
    const { result, unmount } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));

    act(() => root.querySelector("p")!.append(" store"));
    await delivered();
    expect(frames.pending()).toBe(1);
    unmount();
    expect(frames.pending()).toBe(0);
    root.querySelector("p")!.append(" store");
    await delivered();
    expect(frames.pending()).toBe(0);
    expect(textWalks()).toBe(1);
  });

  it("indexes the new document when the root changes, and drops matches when it goes", () => {
    stubFindHighlights();
    const first = documentWith("<p>store</p>");
    const second = documentWith("<p>store store</p>");
    const observers = watchObservers();
    const { result, rerender } = renderHook(({ root }) => useRenderedFind(root), {
      initialProps: { root: first as HTMLElement | null },
    });
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));
    expect(result.current.matchCount).toBe(1);

    rerender({ root: second });
    expect(result.current.matchCount).toBe(2);
    const [firstObserver, secondObserver] = observers.all();
    expect(observers.connected(firstObserver)).toBe(false);
    act(() => result.current.setQuery("stor"));
    expect(result.current.matchCount).toBe(2);

    // Source mode hands the hook no root.
    rerender({ root: null });
    expect(observers.connected(secondObserver)).toBe(false);
    expect(observers.all()).toHaveLength(2);
    expect(result.current.matchCount).toBe(0);
    expect(result.current.isOpen).toBe(true);
    expect(result.current.query).toBe("stor");

    first.querySelector("p")!.append(" store store");
    rerender({ root: first });
    expect(result.current.matchCount).toBe(3);
  });
});
