// @vitest-environment jsdom
// Its own file so its module cache starts cold: the popover's sections load on
// the trigger's hover, focus or open and no sooner (#17034).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";

// Every import of the sections waits on the next deferred the test queues.
const h = vi.hoisted(() => {
  const queue: Array<{ promise: Promise<void>; resolve: () => void; reject: () => void }> = [];
  return {
    imported: vi.fn(),
    queue,
    next() {
      let resolve!: () => void;
      let reject!: () => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = () => rej(new Error("chunk 404"));
      });
      const deferred = { promise, resolve, reject };
      queue.push(deferred);
      return deferred;
    },
  };
});

vi.mock("../WorktreeFilterPopoverContent", async () => {
  h.imported();
  const deferred = h.queue.shift();
  if (!deferred) throw new Error("unexpected import");
  await deferred.promise;
  return {
    WorktreeFilterPopoverContent: ({ filterCount }: { filterCount: number }) => (
      <button type="button">{`${filterCount} in body`}</button>
    ),
  };
});

const { WorktreeFilterPopover } = await import("../WorktreeFilterPopover");

const popover = () =>
  document.querySelector<HTMLElement>('[data-testid="worktree-filter-popover"]');

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
  it("counts from the trigger alone, stays dismissable while loading, and retries a failed load", async () => {
    useWorktreeFilterStore.getState().toggleStatusFilter("dirty");
    useWorktreeFilterStore.getState().toggleStatusFilter("stale");

    render(<WorktreeFilterPopover appearance="field" hideSearchInput />);
    const trigger = screen.getByRole("button", { name: "Filter and sort worktrees, 2 active" });
    // A sidebar that has only been drawn loads nothing.
    expect(h.imported).not.toHaveBeenCalled();

    // A hover starts the load; opening joins it, and the content is up at once.
    const first = h.next();
    await act(async () => {
      fireEvent.pointerEnter(trigger);
    });
    expect(h.imported).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(h.imported).toHaveBeenCalledTimes(1);
    expect(popover()?.querySelector('[aria-busy="true"]')).not.toBeNull();

    // The loading content is a real dismissable layer.
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    await flush();
    expect(popover()).toBeNull();
    // A load that settles after the dismissal draws nothing.
    await act(async () => {
      first.reject();
    });
    await flush();
    expect(popover()).toBeNull();

    // The next open asks again, and reports the failure inside the popover.
    const second = h.next();
    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(h.imported).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.reject();
    });
    await flush();
    expect(popover()?.textContent).toContain("Couldn't load filters");

    // Retry issues the import again, in the same content. Activated from the
    // keyboard, so focus starts on the button that is about to unmount.
    const content = popover();
    const third = h.next();
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(h.imported).toHaveBeenCalledTimes(3);
    expect(popover()).toBe(content);
    expect(content?.querySelector('[aria-busy="true"]')).not.toBeNull();
    // Parked on the content rather than dropped to the document.
    expect(document.activeElement).toBe(content);

    await act(async () => {
      third.resolve();
    });
    await flush();
    const body = screen.getByRole("button", { name: "2 in body" });
    // The trigger's count is the body's count: one number from one snapshot.
    expect(popover()).toBe(content);
    // Sections that land late take the focus a warm open would have given them.
    expect(document.activeElement).toBe(body);

    // Warm: a reopen draws the sections in the content's first commit.
    await act(async () => {
      fireEvent.keyDown(body, { key: "Escape" });
    });
    await flush();
    expect(popover()).toBeNull();
    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(screen.getByRole("button", { name: "2 in body" })).toBeTruthy();
    expect(h.imported).toHaveBeenCalledTimes(3);
  });
});
