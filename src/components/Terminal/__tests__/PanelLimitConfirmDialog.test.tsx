// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelLimitConfirmDialog, describePanelLimitRequest } from "../PanelLimitConfirmDialog";
import {
  preflightSpawnBatchLimit,
  usePanelLimitStore,
  type PanelLimitConfirmRequest,
} from "@/store/panelLimitStore";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: mocks.dispatch } }));

vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const initialState = usePanelLimitStore.getState();

function setLimits(confirmationLimit: number, hardLimit: number) {
  usePanelLimitStore.setState({
    confirmationLimit,
    hardLimit,
    warningsDisabled: false,
    pendingConfirm: null,
  });
}

/**
 * Start a batch the way a recipe run does. The answer comes back boxed: an
 * async function returning the bare promise would wait for the user.
 */
async function startBatch(currentCount: number, requestedCount: number) {
  let result!: Promise<{ allowed: number; declined: boolean }>;
  await act(async () => {
    result = preflightSpawnBatchLimit(currentCount, requestedCount);
  });
  return { result };
}

/** Well past the microtask a StrictMode remount would have declined in. */
const STILL_PENDING_AFTER_MS = 20;

async function settledWithin<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([
    promise,
    new Promise<"pending">((r) => setTimeout(() => r("pending"), STILL_PENDING_AFTER_MS)),
  ]);
}

beforeEach(() => {
  setLimits(20, 32);
  mocks.dispatch.mockReset();
});

afterEach(() => {
  cleanup();
  usePanelLimitStore.setState(initialState, true);
});

describe("PanelLimitConfirmDialog", () => {
  it("keeps a request that is already pending when the host mounts under StrictMode", async () => {
    // The host is lazy: a batch can ask before its chunk has mounted. StrictMode's
    // simulated unmount on that first commit is not a real one.
    const { result } = await startBatch(18, 4);
    render(
      <StrictMode>
        <PanelLimitConfirmDialog />
      </StrictMode>
    );

    expect(await settledWithin(result)).toBe("pending");
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(usePanelLimitStore.getState().pendingConfirm).not.toBeNull();
  });

  it("declines a pending request when the host really unmounts", async () => {
    const { unmount } = render(<PanelLimitConfirmDialog />);
    const { result } = await startBatch(18, 4);

    unmount();

    expect(await result).toEqual({ allowed: 0, declined: true });
    expect(usePanelLimitStore.getState().pendingConfirm).toBeNull();
  });

  it("answers with the button that names the panels it opens", async () => {
    render(<PanelLimitConfirmDialog />);
    const { result } = await startBatch(18, 4);

    const dialog = screen.getByRole("dialog");
    const confirm = screen.getByRole("button", { name: /^Open \d+ panels?$/ });
    expect(confirm.textContent).toContain("4");
    expect(dialog.getAttribute("role")).toBe("dialog");

    fireEvent.click(confirm);
    expect(await result).toEqual({ allowed: 4, declined: false });
  });

  it("reports Cancel and Escape as a decline, not as the limit refusing", async () => {
    render(<PanelLimitConfirmDialog />);
    const first = await startBatch(18, 4);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await first.result).toEqual({ allowed: 0, declined: true });

    const second = await startBatch(18, 4);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(await second.result).toEqual({ allowed: 0, declined: true });
  });

  it("declines the batch before opening the panel limit settings", async () => {
    render(<PanelLimitConfirmDialog />);
    const { result } = await startBatch(18, 4);

    fireEvent.click(screen.getByRole("button", { name: /change limits/i }));

    expect(await result).toEqual({ allowed: 0, declined: true });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    const [actionId, args] = mocks.dispatch.mock.calls[0]!;
    expect(actionId).toBe("app.settings.openTab");
    // The section the thresholds are edited in, whatever the tab is called.
    expect(args).toMatchObject({ sectionId: "terminal-panel-limits" });
  });
});

describe("describePanelLimitRequest", () => {
  const base: PanelLimitConfirmRequest = {
    currentCount: 18,
    requestedCount: 4,
    allowedCount: 4,
    confirmationLimit: 20,
    hardLimit: 32,
  };

  function numbersIn(text: string): number[] {
    return (text.match(/\d+/g) ?? []).map(Number);
  }

  it("states what is open now, what the batch adds, the total and the threshold", () => {
    const copy = describePanelLimitRequest(base);
    const stated = numbersIn(copy.description);
    expect(stated).toContain(base.currentCount);
    expect(stated).toContain(base.allowedCount);
    expect(stated).toContain(base.currentCount + base.allowedCount);
    expect(stated).toContain(base.confirmationLimit);
    // The title and the button count what opens, never the resulting total.
    expect(numbersIn(copy.title)).toEqual([base.allowedCount]);
    expect(numbersIn(copy.confirmLabel)).toEqual([base.allowedCount]);
  });

  it("discloses a batch the hard limit trimmed, with how many will not open", () => {
    const request = { ...base, currentCount: 29, requestedCount: 6, allowedCount: 3 };
    const copy = describePanelLimitRequest(request);
    const stated = numbersIn(copy.description);
    expect(stated).toContain(request.requestedCount);
    expect(stated).toContain(request.allowedCount);
    expect(stated).toContain(request.requestedCount - request.allowedCount);
    expect(stated).toContain(request.hardLimit);
    expect(numbersIn(copy.title)).toEqual([request.allowedCount, request.requestedCount]);
    expect(numbersIn(copy.confirmLabel)).toEqual([request.allowedCount]);
  });

  it("gives differently trimmed batches different copy", () => {
    const a = describePanelLimitRequest({
      ...base,
      currentCount: 29,
      requestedCount: 6,
      allowedCount: 3,
    });
    const b = describePanelLimitRequest({
      ...base,
      currentCount: 31,
      requestedCount: 5,
      allowedCount: 1,
    });
    expect(a.title).not.toBe(b.title);
    expect(a.description).not.toBe(b.description);
  });

  it("never pairs 1 with a plural noun", () => {
    for (const request of [
      { ...base, currentCount: 20, requestedCount: 1, allowedCount: 1 },
      { ...base, currentCount: 31, requestedCount: 5, allowedCount: 1 },
      { ...base, currentCount: 1, requestedCount: 20, allowedCount: 20, confirmationLimit: 4 },
    ]) {
      const copy = describePanelLimitRequest(request);
      for (const text of [copy.title, copy.description, copy.confirmLabel]) {
        expect(text).not.toMatch(/\b1 panels\b/);
      }
    }
  });

  it("names the recipe when the batch is one", () => {
    const copy = describePanelLimitRequest({
      ...base,
      source: { kind: "recipe", name: "Claude + Codex pair" },
    });
    expect(copy.description).toContain("Claude + Codex pair");
  });

  it("names every kind of batch source differently from an unnamed launch", () => {
    const unnamed = describePanelLimitRequest(base).description;
    const cloned = describePanelLimitRequest({ ...base, source: { kind: "clone-layout" } });
    expect(cloned.description).not.toBe(unnamed);
    expect(cloned.description.toLowerCase()).toContain("layout");
  });

  it("says a trimmed batch keeps its first panels, since callers spawn in launch order", () => {
    for (const allowedCount of [1, 3]) {
      const copy = describePanelLimitRequest({
        ...base,
        currentCount: 32 - allowedCount,
        requestedCount: 6,
        allowedCount,
      });
      expect(copy.description).toMatch(/\bfirst\b/);
    }
  });

  it("follows the confirm-dialog microcopy rules", () => {
    for (const request of [
      base,
      { ...base, currentCount: 29, requestedCount: 6, allowedCount: 3 },
      { ...base, currentCount: 0, requestedCount: 24, allowedCount: 24 },
    ]) {
      const copy = describePanelLimitRequest(request);
      expect(copy.title.endsWith("?")).toBe(true);
      expect(copy.confirmLabel).not.toMatch(/[.?!]$/);
      expect(copy.confirmLabel).not.toMatch(/anyway/i);
      expect(copy.description).not.toMatch(/\b0 already open\b/);
    }
  });
});
