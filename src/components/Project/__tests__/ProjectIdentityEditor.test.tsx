/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  OverlayFocusRestoreContext,
  type OverlayFocusRestore,
} from "@/components/ui/overlay-focus-restore";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import type { Project } from "@shared/types";

const { updateProjectMock } = vi.hoisted(() => ({ updateProjectMock: vi.fn() }));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ updateProject: updateProjectMock }),
}));

// Render popover content inline — this test is about the editing contract, not
// Radix's positioning. Three handlers are captured rather than swallowed
// because production depends on when each one fires:
// - `onEscapeKeyDown`: Radix fires it from a document CAPTURE listener BEFORE
//   the input's own keydown, and the cancel-vs-commit ordering hangs on that.
//   A mock that dropped it would let a broken Escape path pass while
//   production saved the edit.
// - `onCloseAutoFocus`: this popover is anchored rather than triggered, so it
//   owns the focus return itself.
// - the root's `onOpenChange`: the dismissal path that commits a pending edit.
let escapeKeyDownHandler: ((event: { preventDefault: () => void }) => void) | null = null;
let closeAutoFocusHandler: ((event: { preventDefault: () => void }) => void) | null = null;
let openChangeHandler: ((open: boolean) => void) | null = null;
let pointerDownOutsideHandler: (() => void) | null = null;

// Enough of the shared policy for the component to register its restore target
// against. The real one is exercised by the primitives' own tests.
const setRestoreTargetMock = vi.fn<(node: HTMLElement | null) => void>();
const focusRestoreStub = {
  setRestoreTarget: setRestoreTargetMock,
  resetForOpen: () => {},
  deferToRadix: () => {},
  onContentPointerDown: () => {},
  onContentPointerDownOutside: () => {},
  onContentInteractOutside: () => {},
  onContentKeyDown: () => {},
  onContentClick: () => {},
  onContentCloseAutoFocus: () => {},
} satisfies OverlayFocusRestore;

vi.mock("@/components/ui/popover", () => ({
  // Radix's Popover root renders no DOM of its own, and neither can this mock —
  // but it does provide the shared focus-restore context, which is how the
  // component hands the policy a restore target.
  Popover: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (o: boolean) => void;
  }) => {
    openChangeHandler = onOpenChange ?? null;
    return (
      <OverlayFocusRestoreContext.Provider value={focusRestoreStub}>
        {children}
      </OverlayFocusRestoreContext.Provider>
    );
  },
  PopoverAnchor: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    onEscapeKeyDown,
    onCloseAutoFocus,
    // Not a DOM prop — kept off the div, and handed to the tests instead.
    onPointerDownOutside,
    onOpenAutoFocus: _onOpenAutoFocus,
    ...rest
  }: {
    children: ReactNode;
    onEscapeKeyDown?: (event: { preventDefault: () => void }) => void;
    onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
    onPointerDownOutside?: () => void;
    onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
  }) => {
    escapeKeyDownHandler = onEscapeKeyDown ?? null;
    closeAutoFocusHandler = onCloseAutoFocus ?? null;
    pointerDownOutsideHandler = onPointerDownOutside ?? null;
    return (
      <div data-testid="popover-content" {...rest}>
        {children}
      </div>
    );
  },
}));

/** Drive Escape the way Radix does — via the content handler, not the input. */
function pressEscape(): boolean {
  let defaultPrevented = false;
  // Invoked directly rather than through fireEvent, so the state updates it
  // makes need an explicit act().
  act(() => {
    escapeKeyDownHandler?.({
      preventDefault: () => {
        defaultPrevented = true;
      },
    });
  });
  return defaultPrevented;
}

/** Drive the close-time focus return the way Radix does. */
function closeAutoFocus(): boolean {
  let defaultPrevented = false;
  act(() => {
    closeAutoFocusHandler?.({
      preventDefault: () => {
        defaultPrevented = true;
      },
    });
  });
  return defaultPrevented;
}

vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: ({ onEmojiSelect }: { onEmojiSelect: (e: { emoji: string }) => void }) => (
    <button type="button" onClick={() => onEmojiSelect({ emoji: "🦄" })}>
      pick-unicorn
    </button>
  ),
}));

import { ProjectIdentityEditor } from "../ProjectIdentityEditor";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    path: "/repos/my-api",
    name: "my-api",
    emoji: DEFAULT_PROJECT_EMOJI,
    lastOpened: 0,
    ...overrides,
  };
}

function nameField() {
  return screen.getByLabelText<HTMLInputElement>(/project name/i);
}

/** The component is controlled by the toolbar; every test opens it. */
function renderEditor(
  project: Project = makeProject(),
  props: { onOpenChange?: (open: boolean) => void; onCloseAutoFocus?: () => void } = {}
) {
  return render(
    <ProjectIdentityEditor
      project={project}
      open
      onOpenChange={props.onOpenChange ?? (() => {})}
      onCloseAutoFocus={props.onCloseAutoFocus}
    />
  );
}

/** Mirrors the toolbar: the pill this popover anchors to and hands focus back to. */
function renderPill() {
  const pill = document.createElement("button");
  pill.type = "button";
  pill.dataset.testid = "project-switcher-trigger";
  document.body.appendChild(pill);
  return pill;
}

describe("ProjectIdentityEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateProjectMock.mockResolvedValue(undefined);
    escapeKeyDownHandler = null;
    closeAutoFocusHandler = null;
    openChangeHandler = null;
    pointerDownOutsideHandler = null;
    document.body.innerHTML = "";
  });

  describe("markup contract", () => {
    it("offers no clickable surface of its own outside the popover", () => {
      const { container } = renderEditor();
      // The whole point of the rewrite: the editor no longer owns a target on
      // the pill, so nothing it renders into the toolbar can take a click.
      // Only the popover body's own controls are interactive.
      const toolbarSide = container.querySelectorAll("[aria-hidden='true']");
      for (const node of toolbarSide) {
        expect(node.tagName).not.toBe("BUTTON");
        expect(node.getAttribute("tabindex")).toBeNull();
      }
      expect(container.querySelector("button button")).toBeNull();
    });

    it("names the popover so it is not announced as a bare dialog", () => {
      renderEditor();
      expect(screen.getByLabelText("Edit project identity")).not.toBeNull();
    });
  });

  describe("focus return", () => {
    it("hands focus back to the pill after a keyboard close, which Radix cannot", () => {
      const pill = renderPill();
      renderEditor();

      pressEscape();
      // Radix restores to a TRIGGER; an anchored popover has none, so an
      // unclaimed keyboard close drops focus on document.body and the next Tab
      // restarts from the top of the document.
      expect(closeAutoFocus()).toBe(true);

      expect(document.activeElement).toBe(pill);
    });

    it("asks for the ring on a keyboard close, since Chromium paints one either way", () => {
      const pill = renderPill();
      const focusSpy = vi.spyOn(pill, "focus");
      renderEditor();

      pressEscape();
      closeAutoFocus();

      // Anything but an explicit `focusVisible: false` leaves the ring on,
      // which is what a keyboard user is owed.
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(focusSpy.mock.calls[0]![0]).not.toMatchObject({ focusVisible: false });
    });

    it("counts a keyboard emoji pick as a keyboard close", () => {
      const pill = renderPill();
      renderEditor();

      // Tabbing into the picker and pressing Enter reaches the same select
      // callback a mouse click does, so modality is read off the interaction.
      fireEvent.keyDown(screen.getByTestId("popover-content"), { key: "Tab" });
      fireEvent.click(screen.getByText("pick-unicorn"), { detail: 0 });
      closeAutoFocus();

      expect(document.activeElement).toBe(pill);
    });

    it("gives the shared policy the pill to aim at, since it has no trigger to record", () => {
      const pill = renderPill();

      renderEditor();

      // Without this the shared policy has nowhere to put focus on a pointer
      // close, and Radix's own restoration targets a null trigger.
      expect(setRestoreTargetMock).toHaveBeenCalledWith(pill);
    });

    it("leaves a pointer close alone so it cannot steal focus from the switcher", () => {
      const pill = renderPill();
      const focusSpy = vi.spyOn(pill, "focus");
      renderEditor();

      // Dismissing by clicking the pill opens the switcher and focuses its
      // search box. Restoring here would yank focus straight back out of it —
      // the shared policy in overlay-focus-restore owns this case.
      act(() => pointerDownOutsideHandler?.());
      expect(closeAutoFocus()).toBe(false);

      expect(focusSpy).not.toHaveBeenCalled();
    });

    it("does not treat a pointer press that never closed the popover as keyboard", () => {
      const pill = renderPill();
      const focusSpy = vi.spyOn(pill, "focus");
      renderEditor();

      // Click into the name field, type, then click away: the typing must not
      // reclassify the pointer dismissal that follows it.
      fireEvent.keyDown(nameField(), { key: "a" });
      act(() => pointerDownOutsideHandler?.());
      closeAutoFocus();

      expect(focusSpy).not.toHaveBeenCalled();
    });

    it("lets the toolbar hold the pill's tooltip down across every close", () => {
      renderPill();
      const onCloseAutoFocus = vi.fn();
      renderEditor(makeProject(), { onCloseAutoFocus });

      // Fires whoever owns the restoration — the tooltip half is never a policy
      // choice.
      closeAutoFocus();

      expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
    });
  });

  describe("emoji", () => {
    it("persists an emoji picked from the full picker", () => {
      renderEditor();

      fireEvent.click(screen.getByText("pick-unicorn"));

      expect(updateProjectMock).toHaveBeenCalledWith("p1", { emoji: "🦄" });
    });

    it("closes itself once an emoji is picked", () => {
      const onOpenChange = vi.fn();
      renderEditor(makeProject(), { onOpenChange });

      fireEvent.click(screen.getByText("pick-unicorn"));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("offers the name-derived suggestion while the project still shows the tree", () => {
      renderEditor(makeProject({ name: "my-api" }));

      const suggested = screen.getByRole("button", { name: /use suggested/i });
      fireEvent.click(suggested);

      expect(updateProjectMock).toHaveBeenCalledWith("p1", {
        emoji: suggestProjectEmoji("my-api"),
      });
    });

    it("hides the suggestion once the project has a non-default emoji", () => {
      renderEditor(makeProject({ emoji: "🚀" }));

      expect(screen.queryByRole("button", { name: /use suggested/i })).toBeNull();
    });

    it("does not write when the picked emoji already matches", () => {
      renderEditor(makeProject({ emoji: "🦄" }));

      fireEvent.click(screen.getByText("pick-unicorn"));

      expect(updateProjectMock).not.toHaveBeenCalled();
    });

    it("carries a pending name edit along when an emoji is picked", () => {
      renderEditor();

      fireEvent.change(nameField(), { target: { value: "Renamed" } });
      // Picking closes the popover programmatically, which does NOT fire
      // onOpenChange — so this write is the only chance the rename gets.
      fireEvent.click(screen.getByText("pick-unicorn"));

      expect(updateProjectMock).toHaveBeenCalledTimes(1);
      expect(updateProjectMock).toHaveBeenCalledWith("p1", {
        name: "Renamed",
        emoji: "🦄",
      });
    });

    it("suggests from the edited draft, not the committed name", () => {
      renderEditor(makeProject({ name: "plain" }));

      fireEvent.change(nameField(), { target: { value: "docs" } });
      fireEvent.click(screen.getByRole("button", { name: /use suggested/i }));

      expect(updateProjectMock).toHaveBeenCalledWith("p1", {
        name: "docs",
        emoji: suggestProjectEmoji("docs"),
      });
    });
  });

  describe("name", () => {
    it("commits a renamed project on Enter", () => {
      renderEditor();

      fireEvent.change(nameField(), { target: { value: "Renamed" } });
      fireEvent.keyDown(nameField(), { key: "Enter" });

      expect(updateProjectMock).toHaveBeenCalledWith("p1", { name: "Renamed" });
    });

    it("commits a pending edit when the popover is dismissed", () => {
      renderEditor();

      fireEvent.change(nameField(), { target: { value: "Renamed" } });
      // Clicking away closes through the root rather than through either of the
      // component's own exits.
      act(() => openChangeHandler?.(false));

      expect(updateProjectMock).toHaveBeenCalledWith("p1", { name: "Renamed" });
    });

    it("trims before committing", () => {
      renderEditor();

      fireEvent.change(nameField(), { target: { value: "   Spaced   " } });
      fireEvent.keyDown(nameField(), { key: "Enter" });

      expect(updateProjectMock).toHaveBeenCalledWith("p1", { name: "Spaced" });
    });

    it("treats an emptied field as no change rather than erasing the name", () => {
      renderEditor();

      fireEvent.change(nameField(), { target: { value: "   " } });
      fireEvent.keyDown(nameField(), { key: "Enter" });

      expect(updateProjectMock).not.toHaveBeenCalled();
      expect(nameField().value).toBe("my-api");
    });

    it("does not write when the name is unchanged", () => {
      renderEditor();

      fireEvent.keyDown(nameField(), { key: "Enter" });

      expect(updateProjectMock).not.toHaveBeenCalled();
    });

    it("reverts the draft on Escape without writing", () => {
      renderEditor();

      fireEvent.change(nameField(), { target: { value: "Abandoned" } });
      // Radix dismisses on Escape by default, which would run the close-commit
      // before any revert; the cancel path must take the close over itself.
      expect(pressEscape()).toBe(true);

      expect(updateProjectMock).not.toHaveBeenCalled();
      expect(nameField().value).toBe("my-api");
    });

    it("re-seeds the draft when the project changes underneath it", () => {
      const { rerender } = renderEditor();
      fireEvent.change(nameField(), { target: { value: "Draft" } });

      rerender(
        <ProjectIdentityEditor
          project={makeProject({ id: "p2", name: "other" })}
          open
          onOpenChange={() => {}}
        />
      );

      // A stale draft must never be committable against a different project.
      expect(nameField().value).toBe("other");
    });

    it("does not write an untouched draft over a rename from elsewhere", () => {
      const { rerender } = renderEditor(makeProject({ name: "A" }));
      // Same project id, renamed in another window while this sat open and
      // untouched. Closing must not resurrect the old name.
      rerender(
        <ProjectIdentityEditor project={makeProject({ name: "B" })} open onOpenChange={() => {}} />
      );

      fireEvent.click(screen.getByText("pick-unicorn"));

      expect(updateProjectMock).toHaveBeenCalledWith("p1", { emoji: "🦄" });
    });
  });
});
