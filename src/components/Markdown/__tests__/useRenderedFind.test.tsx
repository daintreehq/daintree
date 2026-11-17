// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRenderedFind } from "../useRenderedFind";
import { restoreFindHighlights, stubFindHighlights } from "./findHighlightStub";

afterEach(() => {
  try {
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
});
