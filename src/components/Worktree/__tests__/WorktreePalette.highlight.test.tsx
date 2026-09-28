// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

vi.mock("@/hooks", () => ({
  useEscapeStack: () => {},
  useOverlayState: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

vi.mock("@/hooks/useKeybinding", () => ({
  useEffectiveCombo: () => null,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreePalette } from "../WorktreePalette";

const MARK = ".bg-overlay-medium";

function worktree(id: string, name: string, branch: string, issueTitle?: string): WorktreeState {
  return {
    id,
    worktreeId: id,
    name,
    branch,
    path: `/repo/${id}`,
    isCurrent: false,
    issueTitle,
    worktreeChanges: null,
    lastActivityTimestamp: null,
  };
}

function renderPalette(query: string, results: WorktreeState[], selectedIndex = 0) {
  return render(
    <TooltipProvider>
      <WorktreePalette
        isOpen
        query={query}
        results={results}
        totalResults={results.length}
        activeWorktreeId={null}
        selectedIndex={selectedIndex}
        onQueryChange={() => {}}
        onSelectPrevious={() => {}}
        onSelectNext={() => {}}
        onSelect={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
        onSelectIndex={() => {}}
      />
    </TooltipProvider>
  );
}

const option = (id: string) => document.getElementById(`worktree-option-${id}`)!;
const marks = (el: Element) => Array.from(el.querySelectorAll(MARK)).map((m) => m.textContent);

describe("WorktreePalette match highlighting", () => {
  const retry = worktree("a", "retry-jitter", "fix/Retry-Backoff-JITTER");
  const oauth = worktree("b", "oauth-device", "feature/oauth-device-flow");
  const billing = worktree("c", "billing", "feature/billing", "Jitter in retries");
  const rows = [retry, oauth, billing];

  it("marks only what the filter matched, in both the name and the branch", () => {
    renderPalette(" Jitter", rows);
    for (const text of marks(option("a"))) expect(text?.toLowerCase()).toBe("jitter");
    expect(marks(option("a"))).toHaveLength(2);
    expect(marks(option("b"))).toHaveLength(0);
  });

  it("marks the row Enter acts on as well as resting rows", () => {
    renderPalette("device", rows, 1);
    expect(option("b").getAttribute("aria-selected")).toBe("true");
    expect(marks(option("b"))).toEqual(["device", "device"]);
  });

  it("marks nothing on a row the filter matched through a field it does not show", () => {
    renderPalette("jitter", [billing]);
    expect(marks(option("c"))).toHaveLength(0);
    expect(option("c").textContent).toContain("billing");
  });

  it("marks nothing with an empty query", () => {
    renderPalette("", rows);
    expect(document.querySelectorAll(MARK)).toHaveLength(0);
  });
});
