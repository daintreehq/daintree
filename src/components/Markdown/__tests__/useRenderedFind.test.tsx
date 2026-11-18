// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRenderedFind } from "../useRenderedFind";
import { restoreFindHighlights, stubFindHighlights } from "./findHighlightStub";

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
      Array.from({ length: 200 }, (_, i) => `<p>Block ${i} keeps a <em>store</em> here</p>`).join(
        ""
      )
    );
    const textWalks = countTextWalks();
    const { result } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    for (const query of ["s", "st", "sto", "stor", "store", "stores"]) {
      act(() => result.current.setQuery(query));
    }
    expect(result.current.matchCount).toBe(0);
    act(() => result.current.setQuery("store"));
    expect(result.current.matchCount).toBe(200);
    act(() => result.current.toggleMatchCase());
    expect(result.current.matchCount).toBe(200);
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
    // A live edit mid-composition refreshes nothing: the draft is not a query yet.
    act(() => root.querySelector("p")!.append(" て"));
    await act(nextFrame);
    expect(result.current.matchCount).toBe(1);
    expect(textWalks()).toBe(1);

    act(() => result.current.endComposition("店舗"));
    expect(result.current.matchCount).toBe(2);
    expect(textWalks()).toBe(2);
  });

  it("follows a live edit to the document under the open bar", async () => {
    stubFindHighlights();
    const root = documentWith("<p>store</p>");
    const textWalks = countTextWalks();
    const { result } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));
    expect(result.current.matchCount).toBe(1);

    act(() => root.querySelector("p")!.append(" store"));
    await waitFor(() => expect(result.current.matchCount).toBe(2));
    act(() => result.current.setQuery("stores"));
    expect(result.current.matchCount).toBe(0);
    act(() => result.current.setQuery("store"));
    expect(result.current.matchCount).toBe(2);
    expect(textWalks()).toBe(2);
  });

  it("drops matches that become hidden and brings them back, with the query held", async () => {
    stubFindHighlights();
    const root = documentWith("<p>store <span>store</span></p>");
    const span = root.querySelector("span")!;
    const { result } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));
    expect(result.current.matchCount).toBe(2);

    act(() => span.setAttribute("aria-hidden", "true"));
    await waitFor(() => expect(result.current.matchCount).toBe(1));
    act(() => span.removeAttribute("aria-hidden"));
    await waitFor(() => expect(result.current.matchCount).toBe(2));
  });

  it("lets go of the index on close and builds a fresh one on reopen", () => {
    stubFindHighlights();
    const root = documentWith("<p>store</p>");
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const textWalks = countTextWalks();
    const { result } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));
    expect(observe).toHaveBeenCalledTimes(1);
    const observer = observe.mock.contexts[0];
    expect(disconnect.mock.contexts).not.toContain(observer);

    act(() => result.current.close());
    expect(disconnect.mock.contexts).toContain(observer);

    root.querySelector("p")!.append(" store");
    act(() => result.current.open());
    expect(result.current.matchCount).toBe(2);
    expect(textWalks()).toBe(2);
  });

  it("stops following the document once unmounted, even with a refresh queued", async () => {
    stubFindHighlights();
    const root = documentWith("<p>store</p>");
    const textWalks = countTextWalks();
    const { result, unmount } = renderHook(() => useRenderedFind(root));
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));

    act(() => root.querySelector("p")!.append(" store"));
    unmount();
    await nextFrame();
    root.querySelector("p")!.append(" store");
    await nextFrame();
    expect(textWalks()).toBe(1);
  });

  it("indexes the new document when the root changes, and drops matches when it goes", () => {
    stubFindHighlights();
    const first = documentWith("<p>store</p>");
    const second = documentWith("<p>store store</p>");
    const { result, rerender } = renderHook(({ root }) => useRenderedFind(root), {
      initialProps: { root: first as HTMLElement | null },
    });
    act(() => result.current.open());
    act(() => result.current.setQuery("store"));
    expect(result.current.matchCount).toBe(1);

    rerender({ root: second });
    expect(result.current.matchCount).toBe(2);
    act(() => result.current.setQuery("stor"));
    expect(result.current.matchCount).toBe(2);

    // Source mode hands the hook no root.
    rerender({ root: null });
    expect(result.current.matchCount).toBe(0);
    expect(result.current.isOpen).toBe(true);
    expect(result.current.query).toBe("stor");

    first.querySelector("p")!.append(" store store");
    rerender({ root: first });
    expect(result.current.matchCount).toBe(3);
  });
});
