/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { CommitList } from "../components/CommitList";
import type { GitCommit } from "@shared/types/github";

const dispatchMock = vi.fn();

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: (date: string) => `time:${date}`,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useDebounce", () => ({
  useDebounce: <T,>(value: T) => value,
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  m: new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) => {
          const safeProps = Object.fromEntries(
            Object.entries(rest).filter(
              ([k]) =>
                !["initial", "animate", "exit", "transition", "variants", "layout"].includes(k)
            )
          );
          return <div {...safeProps}>{children}</div>;
        },
    }
  ),
}));

const commitWithBody: GitCommit = {
  hash: "aaaaaaa1bbbbbbb2",
  shortHash: "aaaaaaa",
  message: "feat(auth): add login flow",
  body: "Detailed body line 1.\n\nDetailed body line 2.",
  author: { name: "Alice", email: "alice@example.com" },
  date: "2026-01-01T00:00:00Z",
};

const commitNoBody: GitCommit = {
  hash: "ccccccc3ddddddd4",
  shortHash: "ccccccc",
  message: "fix: tiny patch",
  author: { name: "Bob", email: "bob@example.com" },
  date: "2026-01-02T00:00:00Z",
};

function arrangeDispatchSuccess(items: GitCommit[]) {
  dispatchMock.mockResolvedValue({
    ok: true,
    result: { items, hasMore: false },
  });
}

beforeEach(() => {
  dispatchMock.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function moveToCommit(container: HTMLElement, input: HTMLInputElement, commit: GitCommit) {
  await act(async () => {
    fireEvent.keyDown(input, { key: "ArrowDown" });
  });

  await waitFor(() => {
    expect(input.getAttribute("aria-activedescendant")).toBe(`commit-option-${commit.hash}`);
    expect(
      document.getElementById(`commit-option-${commit.hash}`)?.getAttribute("aria-selected")
    ).toBe("true");
    expect(container.querySelectorAll("[role='option']").length).toBeGreaterThan(0);
  });
}

describe("CommitList Enter key handling", () => {
  it("Enter on a commit with body toggles its expansion (renders body pre)", async () => {
    arrangeDispatchSuccess([commitWithBody, commitNoBody]);
    const { container } = render(<CommitList projectPath="/tmp/repo" />);

    await waitFor(() => {
      expect(container.querySelectorAll("[role='option']").length).toBeGreaterThan(0);
    });

    const input = container.querySelector<HTMLInputElement>("input[role='combobox']");
    expect(input).not.toBeNull();
    if (!input) return;

    await moveToCommit(container, input, commitWithBody);

    const optionsBefore = container.querySelectorAll("[role='option']");
    expect(optionsBefore[0]?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => {
      const optionsAfter = container.querySelectorAll("[role='option']");
      expect(optionsAfter[0]?.getAttribute("aria-expanded")).toBe("true");
    });
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("Detailed body line 1.");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("Enter on a commit without body copies its hash", async () => {
    arrangeDispatchSuccess([commitNoBody]);
    const { container } = render(<CommitList projectPath="/tmp/repo" />);

    await waitFor(() => {
      expect(container.querySelectorAll("[role='option']").length).toBeGreaterThan(0);
    });

    const input = container.querySelector<HTMLInputElement>("input[role='combobox']");
    expect(input).not.toBeNull();
    if (!input) return;

    await moveToCommit(container, input, commitNoBody);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(commitNoBody.hash);
    const option = container.querySelector("[role='option']");
    expect(option?.hasAttribute("aria-expanded")).toBe(false);
  });

  it("Load More append preserves existing expansions", async () => {
    dispatchMock
      .mockResolvedValueOnce({
        ok: true,
        result: { items: [commitWithBody], hasMore: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { items: [commitNoBody], hasMore: false },
      });

    const { container } = render(<CommitList projectPath="/tmp/repo" />);

    await waitFor(() => {
      expect(container.querySelectorAll("[role='option']").length).toBe(1);
    });

    const input = container.querySelector<HTMLInputElement>("input[role='combobox']");
    expect(input).not.toBeNull();
    if (!input) return;

    await moveToCommit(container, input, commitWithBody);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => {
      const firstOption = container.querySelector("[role='option']");
      expect(firstOption?.getAttribute("aria-expanded")).toBe("true");
    });

    const loadMore = container.querySelector("#commit-load-more");
    expect(loadMore).not.toBeNull();

    await act(async () => {
      fireEvent.click(loadMore!);
    });

    await waitFor(() => {
      expect(container.querySelectorAll("[role='option']").length).toBe(2);
    });

    const firstOptionAfter = container.querySelectorAll("[role='option']")[0];
    expect(firstOptionAfter?.getAttribute("aria-expanded")).toBe("true");
  });

  it("Enter on no-body commit with missing clipboard does not crash", async () => {
    arrangeDispatchSuccess([commitNoBody]);
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const { container } = render(<CommitList projectPath="/tmp/repo" />);
    await waitFor(() => {
      expect(container.querySelectorAll("[role='option']").length).toBe(1);
    });

    const input = container.querySelector<HTMLInputElement>("input[role='combobox']");
    expect(input).not.toBeNull();
    if (!input) return;

    await moveToCommit(container, input, commitNoBody);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    // No crash, no unhandled rejection — passes if we reach here.
  });

  it("Enter toggles expansion off when pressed twice on the same commit", async () => {
    arrangeDispatchSuccess([commitWithBody]);
    const { container } = render(<CommitList projectPath="/tmp/repo" />);

    await waitFor(() => {
      expect(container.querySelectorAll("[role='option']").length).toBeGreaterThan(0);
    });

    const input = container.querySelector<HTMLInputElement>("input[role='combobox']");
    expect(input).not.toBeNull();
    if (!input) return;

    await moveToCommit(container, input, commitWithBody);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    const expandedRegion = container.querySelector(".grid.transition-\\[grid-template-rows\\]");
    expect(expandedRegion?.className).toContain("grid-rows-[1fr]");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    const collapsedRegion = container.querySelector(".grid.transition-\\[grid-template-rows\\]");
    expect(collapsedRegion?.className).toContain("grid-rows-[0fr]");
  });
});
