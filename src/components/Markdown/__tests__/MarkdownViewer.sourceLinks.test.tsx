// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

const dispatchMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

import { installAppPluginKitHost } from "@/services/plugin/appPluginKitHost";
import { MarkdownViewer } from "../MarkdownViewer";

installAppPluginKitHost();

const PATHS = { filePath: "/repo/docs/spec.md", rootPath: "/repo" };
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

async function mountSource(content: string) {
  const utils = render(<MarkdownViewer {...PATHS} content={content} viewMode="source" />);
  const view = EditorView.findFromDOM(utils.container.querySelector<HTMLElement>(".cm-editor")!)!;
  // The Markdown grammar loads lazily; links are marked once it parses.
  await waitFor(() => expect(view.contentDOM.querySelector(".cm-sourceLink")).not.toBeNull());
  return { view, container: utils.container };
}

function links(view: EditorView): HTMLElement[] {
  return [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-sourceLink")];
}

function linkWithText(view: EditorView, text: string): HTMLElement {
  const link = links(view).find((el) => el.textContent === text);
  if (!link) throw new Error(`no link mark for ${text}`);
  return link;
}

function mouse(target: EventTarget, type: string, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
    clientX: 10,
    clientY: 10,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

/** A press and release in place, as a reader clicking a link makes it. */
function clickLink(target: HTMLElement, init: MouseEventInit = {}): MouseEvent {
  mouse(target, "mousedown", init);
  mouse(target.ownerDocument, "mouseup", init);
  return mouse(target, "click", init);
}

beforeEach(() => {
  dispatchMock.mockClear();
  // jsdom has no layout: CodeMirror's mouse selection reads a position off the
  // coordinates, so give it a stable one rather than whatever zero rects yield.
  vi.spyOn(EditorView.prototype, "posAndSideAtCoords").mockReturnValue({ pos: 0, assoc: 1 });
  // A press inside a selection measures it to tell a drag-and-drop from a click.
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
});

describe("MarkdownViewer Source links", () => {
  it("follows a bare URL, an autolink, and a link's target on a plain click", async () => {
    const { view } = await mountSource(
      "See https://bare.dev and <https://auto.dev>, or [the guide](../README.md).\n"
    );

    clickLink(linkWithText(view, "https://bare.dev"));
    clickLink(linkWithText(view, "https://auto.dev"));
    clickLink(linkWithText(view, "../README.md"));

    expect(dispatchMock.mock.calls).toEqual([
      ["browser.openExternal", { url: "https://bare.dev" }, { source: "user" }],
      ["browser.openExternal", { url: "https://auto.dev" }, { source: "user" }],
      [
        "file.view",
        { path: "/repo/README.md", rootPath: "/repo", confineToRoot: true },
        { source: "user" },
      ],
    ]);
  });

  it("marks only links that go somewhere, so the rest keep the text cursor", async () => {
    const { view } = await mountSource(
      "[out](../../outside.md) [frag](#setup) [js](javascript:alert(1)) [x](x:notes.md) [ok](./ok.md)\n"
    );
    expect(links(view).map((el) => el.textContent)).toEqual(["./ok.md"]);
  });

  it("does not follow a press that drags, even one that comes back to where it started", async () => {
    const { view } = await mountSource("Read https://bare.dev today.\n");
    const link = linkWithText(view, "https://bare.dev");

    mouse(link, "mousedown");
    mouse(document, "mousemove", { clientX: 60, buttons: 1 });
    mouse(document, "mousemove", { clientX: 10, buttons: 1 });
    mouse(document, "mouseup");
    mouse(link, "click");

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("does not follow a click that leaves a selection, extends one, or repeats", async () => {
    const { view } = await mountSource("Read https://bare.dev today.\n");
    const link = linkWithText(view, "https://bare.dev");

    mouse(link, "mousedown");
    mouse(document, "mouseup");
    view.dispatch({ selection: { anchor: 5, head: 12 } });
    mouse(link, "click");

    clickLink(link, { shiftKey: true });
    clickLink(link, { detail: 2 });

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("does not follow a press that starts off the link and is released on it", async () => {
    const { view, container } = await mountSource("Read https://bare.dev today.\n");
    const line = container.querySelector<HTMLElement>(".cm-line")!;

    mouse(line, "mousedown");
    mouse(document, "mouseup");
    mouse(linkWithText(view, "https://bare.dev"), "click");

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("follows again after a drag it ignored", async () => {
    const { view } = await mountSource("Read https://bare.dev today.\n");
    const link = linkWithText(view, "https://bare.dev");

    mouse(link, "mousedown");
    mouse(document, "mousemove", { clientX: 60, buttons: 1 });
    mouse(document, "mouseup");
    mouse(link, "click");
    clickLink(link);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  // Clearing a find match on the press can redraw the link, and Chromium then
  // aims the click at the line around it.
  it("follows the pressed link when the click lands on the line around it", async () => {
    const { view, container } = await mountSource("Read https://bare.dev today.\n");

    mouse(linkWithText(view, "https://bare.dev"), "mousedown");
    mouse(document, "mouseup");
    mouse(container.querySelector<HTMLElement>(".cm-line")!, "click");

    expect(dispatchMock).toHaveBeenCalledWith(
      "browser.openExternal",
      { url: "https://bare.dev" },
      { source: "user" }
    );
  });

  it("sends a URL written in a link's text where the link goes", async () => {
    const { view } = await mountSource("[https://x.dev](./guide.md)\n");

    clickLink(linkWithText(view, "https://x.dev"));

    expect(dispatchMock).toHaveBeenCalledWith(
      "file.view",
      { path: "/repo/docs/guide.md", rootPath: "/repo", confineToRoot: true },
      { source: "user" }
    );
  });
});
