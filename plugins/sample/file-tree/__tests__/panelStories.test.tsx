// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, waitFor } from "@testing-library/react";
import {
  listPanelStories,
  mountPanelStory,
  type MountedPanelPreview,
  type PanelStory,
} from "@daintreehq/plugin-sdk/testing/preview";
import * as stories from "../review/panel.stories";

let preview: MountedPanelPreview | null = null;

afterEach(() => {
  if (preview) void act(() => preview?.unmount());
  preview = null;
  document.body.innerHTML = "";
});

async function show(story: PanelStory): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    preview = mountPanelStory(stories.default, story, { container });
  });
  await act(async () => {
    await preview?.ready;
  });
  return container;
}

function rowNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[role=treeitem]")].map(
    (row) => row.querySelector("[data-category]")?.textContent ?? ""
  );
}

describe("sample file tree stories", () => {
  it("lists every state of the panel", () => {
    expect(listPanelStories(stories).map((story) => story.exportName)).toEqual([
      "Empty",
      "Loading",
      "Populated",
      "UnreadableDirectory",
      "Disconnected",
    ]);
  });

  it("Empty shows the no-worktree state", async () => {
    const container = await show(stories.Empty);
    await waitFor(() =>
      expect(container.querySelector("[data-testid=file-tree-empty]")).not.toBeNull()
    );
  });

  it("Loading renders the tree with no rows while the listing is outstanding", async () => {
    const container = await show(stories.Loading);
    await waitFor(() =>
      expect(container.querySelector("[data-testid=file-tree-view]")).not.toBeNull()
    );
    expect(rowNames(container)).toEqual([]);
  });

  it("Populated restores the expanded directory and the selection", async () => {
    const container = await show(stories.Populated);
    // The listings arrive through one serialized queue of host calls.
    await waitFor(() => expect(rowNames(container)).toContain("styles.css"));
    const names = rowNames(container);
    // Expanded: `src`'s children follow it directly. Collapsed: `docs` has none.
    expect(names.slice(names.indexOf("src"), names.indexOf("src") + 4)).toEqual([
      "src",
      "index.ts",
      "panel.tsx",
      "styles.css",
    ]);
    expect(names).toContain("docs");
    expect(names).not.toContain("guide.md");
    // Dotfiles are hidden by default, as in the app.
    expect(names).not.toContain(".env");
    const selected = container.querySelector("[aria-selected=true]");
    expect(selected?.getAttribute("data-testid")).toBe("file-tree-row-src/panel.tsx");
    expect(preview?.host.invocations("list-directory")).toEqual([
      [{ dirPath: "/work/repo" }],
      [{ dirPath: "/work/repo/src" }],
    ]);
  });

  it("UnreadableDirectory marks the directory the host refused", async () => {
    const container = await show(stories.UnreadableDirectory);
    await waitFor(() =>
      expect(container.querySelector("[data-testid='file-tree-failed-docs']")).not.toBeNull()
    );
  });

  it("Disconnected falls back to the empty state", async () => {
    const container = await show(stories.Disconnected);
    await waitFor(() =>
      expect(container.querySelector("[data-testid=file-tree-empty]")).not.toBeNull()
    );
  });
});
