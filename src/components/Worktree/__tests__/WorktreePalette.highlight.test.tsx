// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
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
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";

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

describe("WorktreePalette custom titles", () => {
  const titled = worktree("t", "feature/auth-refresh", "feature/auth-refresh");
  const plain = worktree("p", "billing", "feature/billing");

  const setTitles = (titles: Record<string, string>) =>
    act(() => useWorktreeFilterStore.setState({ worktreeCustomTitles: titles }));

  // The headline is the one `font-medium` text in the row; the qualifier is the
  // one span that caps its own width.
  const headline = (id: string) => option(id).querySelector<HTMLElement>("span.font-medium");
  const qualifier = (id: string) => option(id).querySelector<HTMLElement>('span[class*="max-w-"]');

  afterEach(() => setTitles({}));

  it("shows the title the sidebar shows, the branch it displaced beside it, the path under it", () => {
    setTitles({ t: "Release planning" });
    renderPalette("", [titled]);
    expect(headline("t")?.textContent).toBe("Release planning");
    expect(qualifier("t")?.textContent).toContain("feature/auth-refresh");
    const detail = option("t").querySelector<HTMLElement>("div.mt-0\\.5");
    expect(detail?.textContent).toContain("/repo/t");
    expect(headline("t")?.textContent).not.toContain("/repo/t");
    // Under the headline line, which the qualifier shares.
    expect(headline("t")!.parentElement?.nextElementSibling).toBe(detail);
    expect(qualifier("t")!.parentElement).toBe(headline("t")!.parentElement);
  });

  it("sets a custom title as a name, and an untitled linked worktree as the mono identifier", () => {
    setTitles({ t: "Release planning" });
    renderPalette("", [titled, plain]);
    expect(headline("t")?.className).not.toContain("font-mono");
    expect(headline("p")?.className).not.toContain("font-mono");
    renderPalette("", [worktree("q", "feature/x", "feature/x")]);
    expect(headline("q")?.className).toContain("font-mono");
  });

  it("marks the title when the query found the title", () => {
    setTitles({ t: "Release planning" });
    renderPalette("planning", [titled]);
    expect(marks(headline("t")!)).toEqual(["planning"]);
    expect(qualifier("t")?.querySelector(MARK)).toBeNull();
  });

  it("marks the branch when the query found the branch the title displaced", () => {
    setTitles({ t: "Release planning" });
    renderPalette("refresh", [titled]);
    expect(marks(qualifier("t")!)).toEqual(["refresh"]);
    expect(headline("t")?.textContent).toBe("Release planning");
    expect(marks(headline("t")!)).toEqual([]);
  });

  it("names a worktree without a title by its name and gives it its differing branch beside it", () => {
    setTitles({ t: "Release planning" });
    renderPalette("", [plain]);
    expect(headline("p")?.textContent).toBe("billing");
    expect(qualifier("p")?.textContent).toContain("feature/billing");
  });

  it("does not repeat the branch when the title is the branch, and shows the folder instead", () => {
    const folder = worktree("f", "refresh-dir", "feature/auth-refresh");
    setTitles({ f: "feature/auth-refresh" });
    renderPalette("", [folder]);
    expect(headline("f")?.textContent).toBe("feature/auth-refresh");
    expect(qualifier("f")?.textContent).toContain("refresh-dir");
    expect(qualifier("f")?.textContent).not.toContain("feature/auth-refresh");
  });

  it("says detached with its commit instead of the branch the snapshot still carries", () => {
    const detached = {
      ...worktree("d", "scratch-dir", "feature/auth-refresh"),
      isDetached: true,
      head: "0123456789abcdef",
    };
    setTitles({ d: "Release planning" });
    renderPalette("", [detached]);
    expect(headline("d")?.textContent).toBe("Release planning");
    expect(qualifier("d")?.textContent).toContain("detached at 0123456");
    expect(option("d").textContent).not.toContain("feature/auth-refresh");
  });

  it("follows a retitle while the row is mounted", () => {
    setTitles({ t: "Release planning" });
    renderPalette("", [titled]);
    expect(headline("t")?.textContent).toBe("Release planning");

    setTitles({ t: "Hotfix rollout" });
    expect(headline("t")?.textContent).toBe("Hotfix rollout");

    setTitles({});
    expect(headline("t")?.textContent).toBe("feature/auth-refresh");
    expect(qualifier("t")).toBeNull();
  });
});
