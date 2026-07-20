/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { FileChangeDetail } from "../../../types";
import type { FileDecoration } from "@shared/types/forge";

// The diff modal and tooltip are irrelevant to the decoration rendering under test.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// No plugin context-menu items — keep the plain-row DOM so badges are the only
// plugin surface under test.
vi.mock("@/hooks/usePluginContextMenuItems", () => ({
  usePluginContextMenuItems: () => [],
}));

// systemClient is only touched on a url-badge click; stub it to avoid pulling
// window.electron at import time.
vi.mock("@/clients/systemClient", () => ({
  systemClient: { openExternal: vi.fn() },
}));

const { decorationsRef, scopeRef, pathsRef } = vi.hoisted(() => ({
  decorationsRef: { current: {} as Record<string, FileDecoration> },
  scopeRef: { current: "" },
  pathsRef: { current: [] as string[] },
}));
vi.mock("@/hooks/useFileTreeDecorations", () => ({
  useFileTreeDecorations: (scope: string, paths: string[]) => {
    scopeRef.current = scope;
    pathsRef.current = paths;
    return decorationsRef.current;
  },
}));

import { FileChangeList } from "../FileChangeList";

const ROOT = "/repo";

function file(path: string, status: FileChangeDetail["status"] = "modified"): FileChangeDetail {
  return { path, status, insertions: 1, deletions: 0 };
}

beforeEach(() => {
  decorationsRef.current = {};
  scopeRef.current = "";
  pathsRef.current = [];
});

afterEach(() => cleanup());

describe("FileChangeList — plugin file decorations", () => {
  it("passes the worktree-files scope and the raw change paths to the hook", () => {
    render(
      <FileChangeList changes={[file("/repo/src/a.ts"), file("/repo/src/b.ts")]} rootPath={ROOT} />
    );
    expect(scopeRef.current).toBe("worktree-files:/repo");
    expect(new Set(pathsRef.current)).toEqual(new Set(["/repo/src/a.ts", "/repo/src/b.ts"]));
  });

  it("renders a badge for a decorated path and nothing for an undecorated one", () => {
    decorationsRef.current = {
      "/repo/src/a.ts": { badge: "3", tooltip: "3 issues" },
    };
    const { container, getByLabelText } = render(
      <FileChangeList changes={[file("/repo/src/a.ts"), file("/repo/src/b.ts")]} rootPath={ROOT} />
    );
    const badge = getByLabelText("3 issues");
    expect(badge.textContent).toBe("3");
    // Only one badge in the whole list — the undecorated row has none.
    expect(container.querySelectorAll('[aria-label="3 issues"]')).toHaveLength(1);
  });

  it("renders no badge DOM when the hook returns an empty map", () => {
    decorationsRef.current = {};
    const { container } = render(
      <FileChangeList changes={[file("/repo/src/a.ts")]} rootPath={ROOT} />
    );
    // FileDecorationBadge returns null without a badge string, so the row carries
    // no rounded-pill badge element.
    expect(container.querySelector(".rounded-full")).toBeNull();
  });

  it("looks decorations up by the raw change.path, not the display relative path", () => {
    // Absolute change path; the component derives a relativePath for display, but
    // the decoration lookup must use the original absolute path the host saw.
    decorationsRef.current = { "/repo/src/deep/x.ts": { badge: "!" } };
    const { getByLabelText } = render(
      <FileChangeList changes={[file("/repo/src/deep/x.ts")]} rootPath={ROOT} />
    );
    expect(getByLabelText("!").textContent).toBe("!");
  });
});
