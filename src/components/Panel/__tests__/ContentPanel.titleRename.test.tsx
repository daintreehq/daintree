// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
  useWorktreeStoreOptional: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => undefined,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: () => false,
}));

vi.mock("@/components/Layout/useDockBlockedState", () => ({
  useDockBlockedState: () => null,
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({
    agentId: undefined,
    iconId: undefined,
    runtimeKind: "shell",
    isAgent: false,
  }),
}));

vi.mock("@/utils/terminalAgentDisplayState", () => ({
  getTerminalAgentDisplayState: () => undefined,
}));

vi.mock("@/components/Terminal/TerminalHeaderContent", () => ({
  TerminalHeaderContent: () => null,
}));

vi.mock("@/store", () => ({
  usePreferencesStore: (
    selector: (s: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
  ) => selector({ showGridAgentHighlights: false, showAgentTaskTitles: true }),
  usePanelStore: (selector: (s: { panelsById: Record<string, never> }) => unknown) =>
    selector({ panelsById: {} }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ContentPanel } from "../ContentPanel";
import { inlineRenameFieldClassName } from "../inlineRenameField";

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function renderPanel(onTitleChange = vi.fn()) {
  render(
    <ContentPanel
      id="p-1"
      title="Docs"
      kind="browser"
      isFocused
      onFocus={() => {}}
      onClose={() => {}}
      onTitleChange={onTitleChange}
    >
      <div />
    </ContentPanel>
  );
  return onTitleChange;
}

const titleButton = () => screen.getByRole("button", { name: /^Browser title: Docs/ });
const titleField = () =>
  screen.getByRole<HTMLInputElement>("textbox", { name: "Edit browser title" });

describe("ContentPanel title rename", () => {
  afterEach(cleanup);

  it.each(["Enter", "Escape"])(
    "hands focus back to the title after a keyboard rename ends with %s",
    async (key) => {
      renderPanel();
      const title = titleButton();
      title.focus();
      fireEvent.keyDown(title, { key: "F2" });
      await act(nextFrame);
      const field = titleField();
      field.focus();
      fireEvent.change(field, { target: { value: "API docs" } });
      fireEvent.keyDown(field, { key });
      await act(nextFrame);
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(document.activeElement).toBe(titleButton());
    }
  );

  it("commits on Enter and discards on Escape", async () => {
    const onTitleChange = renderPanel();
    for (const key of ["Escape", "Enter"]) {
      fireEvent.keyDown(titleButton(), { key: "F2" });
      await act(nextFrame);
      fireEvent.change(titleField(), { target: { value: `after ${key}` } });
      fireEvent.keyDown(titleField(), { key });
      await act(nextFrame);
    }
    expect(onTitleChange.mock.calls).toEqual([["after Enter"]]);
  });

  it("does not re-select text typed in the moment after the field opens", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      renderPanel();
      fireEvent.keyDown(titleButton(), { key: "F2" });
      const field = titleField();
      field.focus();
      fireEvent.change(field, { target: { value: "API" } });
      field.setSelectionRange(3, 3);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect([field.selectionStart, field.selectionEnd]).toEqual([3, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still selects the whole name when nothing has been typed yet", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      renderPanel();
      fireEvent.keyDown(titleButton(), { key: "F2" });
      const field = titleField();
      field.setSelectionRange(0, 0);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wears the shared inline rename look and treats the name as an identifier", () => {
    renderPanel();
    fireEvent.doubleClick(titleButton());
    const field = titleField();
    const classes = field.className.split(/\s+/);
    for (const token of inlineRenameFieldClassName.split(/\s+/)) {
      expect(classes).toContain(token);
    }
    expect(field.getAttribute("spellcheck")).toBe("false");
    expect(field.getAttribute("autocomplete")).toBe("off");
  });
});
