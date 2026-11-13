// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialog } from "@/components/ui/AppDialog";
import { _resetForTests } from "@/lib/escapeStack";
import { _resetForTests as _resetBackstopForTests } from "@/lib/dialogEscapeBackstop";
import { useProjectStore } from "@/store/projectStore";
import type { Project, TerminalRecipe } from "@/types";
import { RecipeEditor } from "../RecipeEditor";

vi.mock("@/store/portalStore", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks/useOverlayState", () => ({
  useOverlayState: () => {},
}));

vi.mock("@/lib/scrollbarGutter", () => ({
  SCROLLBAR_GUTTER_VAR: "--app-scrollbar-gutter",
  measureScrollbarGutter: vi.fn(() => 0),
  publishScrollbarGutter: vi.fn(() => 0),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock("@/components/TerminalRecipe/RecipeVariablePreview", () => ({
  RecipeVariablePreview: () => null,
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const RECIPE: TerminalRecipe = {
  id: "r1",
  name: "Full stack",
  projectId: "proj",
  createdAt: 0,
  terminals: [{ type: "terminal", title: "API", command: "npm run api", env: {} }],
};

// Project settings → Recipes: the editor opens over the Settings dialog, from
// a control inside it.
function SettingsWithEditor() {
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  return (
    <AppDialog isOpen onClose={() => {}} data-testid="settings">
      <AppDialog.Body>
        <button type="button" onClick={() => setIsEditorOpen(true)}>
          Edit Full stack
        </button>
      </AppDialog.Body>
      <RecipeEditor recipe={RECIPE} isOpen={isEditorOpen} onClose={() => setIsEditorOpen(false)} />
    </AppDialog>
  );
}

describe("RecipeEditor discard focus (#16906)", () => {
  let root: HTMLElement;

  beforeEach(() => {
    _resetForTests();
    _resetBackstopForTests();
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    useProjectStore.setState({
      currentProject: { id: "proj", name: "proj", path: "/p", emoji: "🌲", lastOpened: 0 } as Project,
    });
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });

  afterEach(() => {
    cleanup();
    root.remove();
    vi.useRealTimers();
    _resetForTests();
    _resetBackstopForTests();
  });

  // In steps finer than a frame, each its own act, so the two dialogs' exits
  // and first-frame focus land in the order they would on screen.
  const settle = async () => {
    for (let elapsed = 0; elapsed < 500; elapsed += 4) {
      await act(() => vi.advanceTimersByTimeAsync(4));
    }
  };

  async function askToDiscard() {
    render(<SettingsWithEditor />, { container: root });
    await settle();
    const opener = screen.getByRole("button", { name: "Edit Full stack" });
    opener.focus();
    fireEvent.click(opener);
    await settle();

    fireEvent.change(document.getElementById("recipe-name")!, {
      target: { value: "Full stack, renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeTruthy();
    return opener;
  }

  it("hands focus back to the control in Settings that opened the editor", async () => {
    const opener = await askToDiscard();

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await settle();

    expect(document.getElementById("recipe-name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps the editor open, and focus in it, when the discard is cancelled", async () => {
    await askToDiscard();

    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await settle();

    const name = document.getElementById("recipe-name") as HTMLInputElement;
    expect(name.value).toBe("Full stack, renamed");
    expect(name.closest("[data-app-dialog-surface]")?.contains(document.activeElement)).toBe(true);
  });
});
