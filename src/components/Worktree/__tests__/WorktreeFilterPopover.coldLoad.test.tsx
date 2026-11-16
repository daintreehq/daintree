// @vitest-environment jsdom
// Its own file so its module cache starts cold: the popover's body loads on the
// trigger's hover or first open and no sooner (#17034).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";

const h = vi.hoisted(() => {
  let release: () => void = () => {};
  const chunk = new Promise<void>((resolve) => (release = resolve));
  return { chunk, release: () => release(), imported: vi.fn(), failNext: false };
});

// Held back until the test lets the chunk land; `failNext` rejects one import.
vi.mock("../WorktreeFilterPopoverContent", async () => {
  h.imported();
  if (h.failNext) {
    h.failNext = false;
    throw new Error("chunk 404");
  }
  await h.chunk;
  const { PopoverContent } = await import("@/components/ui/popover");
  return {
    WorktreeFilterPopoverContent: ({ filterCount }: { filterCount: number }) => (
      <PopoverContent data-testid="filter-body">
        <button type="button">{`${filterCount} in body`}</button>
      </PopoverContent>
    ),
  };
});

const { WorktreeFilterPopover } = await import("../WorktreeFilterPopover");

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => {
  cleanup();
  useWorktreeFilterStore.getState().clearAll();
});

describe("worktree filter popover, cold (#17034)", () => {
  it("counts from the trigger alone, loads on hover and open, and retries a failed load", async () => {
    useWorktreeFilterStore.getState().toggleStatusFilter("dirty");
    useWorktreeFilterStore.getState().toggleStatusFilter("stale");

    render(<WorktreeFilterPopover appearance="field" hideSearchInput />);
    const trigger = screen.getByRole("button", { name: "Filter and sort worktrees, 2 active" });
    // A sidebar that has only been drawn loads nothing.
    expect(h.imported).not.toHaveBeenCalled();

    // A hover warms the chunk; its failure is the open's to report, not the hover's.
    h.failNext = true;
    await act(async () => {
      fireEvent.pointerEnter(trigger);
    });
    await flush();
    expect(h.imported).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("worktree-filter-popover")).toBeNull();

    h.failNext = true;
    await act(async () => {
      fireEvent.click(trigger);
    });
    await flush();
    expect(h.imported).toHaveBeenCalledTimes(2);
    const failure = screen.getByTestId("worktree-filter-popover");
    expect(failure.textContent).toContain("Couldn't load filters");

    // Retry mounts a fresh loader, which issues the import again.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(h.imported).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("filter-body")).toBeNull();

    await act(async () => {
      h.release();
    });
    await flush();
    const body = screen.getByTestId("filter-body");
    // The trigger's count is the body's count: one number from one snapshot.
    expect(body.textContent).toBe("2 in body");
    expect(body.contains(document.activeElement)).toBe(true);
  });
});
