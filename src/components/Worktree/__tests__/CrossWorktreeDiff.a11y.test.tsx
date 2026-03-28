// @vitest-environment jsdom
import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CrossWorktreeDiff } from "../CrossWorktreeDiff";
import { _resetForTests } from "@/lib/escapeStack";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/store/worktreeDataStore", () => ({
  useWorktreeDataStore: (sel: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    sel({ worktrees: new Map() }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useOverlayState: () => {},
  };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.mock("../DiffViewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));

vi.mock("../WorktreeSelector", () => ({
  WorktreeSelector: ({ label }: { label: string }) => (
    <select aria-label={label}>
      <option>mock</option>
    </select>
  ),
}));

function Dispatcher() {
  useGlobalEscapeDispatcher();
  return null;
}

function renderModal(props: { isOpen?: boolean; onClose?: () => void } = {}) {
  const { isOpen = true, onClose = vi.fn() } = props;
  return {
    onClose,
    ...render(
      <>
        <Dispatcher />
        <CrossWorktreeDiff isOpen={isOpen} onClose={onClose} initialWorktreeId={null} />
      </>
    ),
  };
}

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

describe("CrossWorktreeDiff dialog accessibility", () => {
  beforeEach(() => {
    _resetForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    _resetForTests();
  });

  it("renders with role='dialog' and aria-modal='true' when open", async () => {
    renderModal();
    await act(() => vi.runAllTimersAsync());

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("has aria-labelledby linking to the Compare Worktrees heading", async () => {
    renderModal();
    await act(() => vi.runAllTimersAsync());

    const dialog = screen.getByRole("dialog");
    const labelledById = dialog.getAttribute("aria-labelledby");
    expect(labelledById).toBeTruthy();

    const heading = screen.getByText("Compare Worktrees");
    expect(heading.id).toBe(labelledById);
  });

  it("closes on Escape via useEscapeStack", async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await act(() => vi.runAllTimersAsync());

    pressEscape();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not render the dialog when closed", () => {
    renderModal({ isOpen: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("restores focus to the previously active element on close", async () => {
    const outerButton = document.createElement("button");
    outerButton.textContent = "Trigger";
    document.body.appendChild(outerButton);
    outerButton.focus();

    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <Dispatcher />
        <CrossWorktreeDiff isOpen={true} onClose={onClose} initialWorktreeId={null} />
      </>
    );
    await act(() => vi.runAllTimersAsync());

    // Focus should have moved into the dialog
    expect(document.activeElement).not.toBe(outerButton);

    rerender(
      <>
        <Dispatcher />
        <CrossWorktreeDiff isOpen={false} onClose={onClose} initialWorktreeId={null} />
      </>
    );

    expect(document.activeElement).toBe(outerButton);
    document.body.removeChild(outerButton);
  });
});
