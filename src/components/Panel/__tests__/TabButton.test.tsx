// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TabButton } from "../TabButton";
import { inlineRenameFieldClassName } from "../inlineRenameField";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { GLYPH_SELECTOR } from "@/components/icons/__tests__/glyphBox";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { FleetRunRow } from "@shared/types/ipc/fleet";

// Each tab and session row owns a TerminalContextMenu, which reads the worktree
// store; its scoping is pinned in its own suite, so it is a passthrough here.
vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children?: unknown }) => <>{children as never}</>,
}));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => {
      const {
        layoutId: _layoutId,
        layout: _layout,
        transition: _transition,
        ...rest
      } = props as Record<string, unknown>;
      return (
        <div ref={ref} data-testid="motion-div" {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
          {children}
        </div>
      );
    }
  );
  const MotionInput = React.forwardRef<
    HTMLInputElement,
    React.InputHTMLAttributes<HTMLInputElement>
  >((props, ref) => {
    const {
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      layoutId: _layoutId,
      layout: _layout,
      ...rest
    } = props as Record<string, unknown>;
    return (
      <input
        ref={ref}
        data-testid="motion-input"
        {...(rest as React.InputHTMLAttributes<HTMLInputElement>)}
      />
    );
  });
  const MotionSpan = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
    (props, ref) => {
      const {
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
        layoutId: _layoutId,
        layout: _layout,
        key: _key,
        ...rest
      } = props as Record<string, unknown>;
      return (
        <span
          ref={ref}
          data-testid="motion-span"
          {...(rest as React.HTMLAttributes<HTMLSpanElement>)}
        >
          {props.children}
        </span>
      );
    }
  );
  const AnimatePresenceMock = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return {
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv, input: MotionInput, span: MotionSpan },
    motion: { div: MotionDiv, input: MotionInput, span: MotionSpan },
    AnimatePresence: AnimatePresenceMock,
    LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}));

const defaultProps = {
  id: "test-panel-1",
  title: "Test Agent",
  kind: "terminal" as const,
  type: "claude" as const,
  chrome: deriveTerminalChrome(),
  isActive: true,
  onClick: vi.fn(),
  onClose: vi.fn(),
};

describe("TabButton", () => {
  it("does not show indicator when hasDangerousFlags is false", () => {
    render(<TabButton {...defaultProps} hasDangerousFlags={false} />);

    const indicator = screen.queryByLabelText("Launched with dangerous permissions");
    expect(indicator).toBeNull();
  });

  it("shows both dangerous flag and fallback indicators when both are true", () => {
    render(
      <TabButton
        {...defaultProps}
        hasDangerousFlags={true}
        isUsingFallback={true}
        fallbackTooltip="Using fallback preset"
      />
    );

    const dangerousIndicator = screen.getByLabelText("Launched with dangerous permissions");
    const fallbackIndicator = screen.getByLabelText("Running on fallback preset");

    expect(dangerousIndicator).toBeDefined();
    expect(fallbackIndicator).toBeDefined();
  });

  it("names the live preset when the visible title doesn't (#13746)", () => {
    // The full title still carries the launch stamp; the slot shows the task alone.
    render(
      <TabButton
        {...defaultProps}
        title="Fix auth tests"
        fullTitle="Codex [Personal]: Fix auth tests"
        presetName="Work"
      />
    );
    expect(screen.getByTestId("tab-preset-name").textContent).toBe("Work");
  });

  it("doesn't repeat a preset the visible title already names (#13746)", () => {
    render(<TabButton {...defaultProps} title="Codex [Work]" presetName="Work" />);
    expect(screen.queryByTestId("tab-preset-name")).toBeNull();
  });

  it("renders the active indicator element when isActive is true", () => {
    render(<TabButton {...defaultProps} isActive={true} />);
    const indicator = screen.queryByTestId("motion-div");
    expect(indicator).not.toBeNull();
    expect(indicator?.className).toContain("bg-accent-primary");
  });

  it("does not render the active indicator when isActive is false", () => {
    render(<TabButton {...defaultProps} isActive={false} />);
    const indicator = screen.queryByTestId("motion-div");
    expect(indicator).toBeNull();
  });

  // Regression: before this test, PanelHeader.tsx built TabInfo objects with
  // detectedAgentId but dropped the field when mapping tabs → TabButton/Sortable
  // TabButton props. Result: typing `claude` in a tab correctly updated status
  // chrome (which read detectedAgentId elsewhere) but the tab icon stayed on
  // the generic terminal glyph because TerminalIcon never received the
  // detected id. This test pins the prop thread so a regression fails loud.
  describe("icon tracks terminal chrome descriptor", () => {
    it("renders the launch-affinity agent icon before live detection rehydrates", () => {
      const { container } = render(
        <TabButton {...defaultProps} chrome={deriveTerminalChrome({ launchAgentId: "claude" })} />
      );
      const marker = container.querySelector("[data-terminal-icon-id]");
      expect(marker?.getAttribute("data-terminal-icon-id")).toBe("claude");
    });

    it("switches icon when detectedAgentId changes from undefined to 'claude' (promote)", () => {
      const { container, rerender } = render(
        <TabButton {...defaultProps} chrome={deriveTerminalChrome()} />
      );
      const before = container.innerHTML;

      rerender(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ detectedAgentId: "claude", detectedProcessId: "claude" })}
        />
      );
      const after = container.innerHTML;

      // The icon section must have changed. If the prop thread is broken the
      // rendered markup is byte-identical before and after detection.
      expect(before).not.toBe(after);
    });

    it("switches icon when detectedAgentId clears (demote)", () => {
      const { container, rerender } = render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ detectedAgentId: "claude", detectedProcessId: "claude" })}
        />
      );
      const before = container.innerHTML;

      rerender(<TabButton {...defaultProps} chrome={deriveTerminalChrome()} />);
      const after = container.innerHTML;

      expect(before).not.toBe(after);
    });
  });

  describe("rename commit semantics", () => {
    const enterEditMode = (titleNode: HTMLElement) => {
      fireEvent.doubleClick(titleNode);
    };

    it("commits an empty value as an explicit reset (unlock) on Enter", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId<HTMLInputElement>("motion-input");

      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onRename).toHaveBeenCalledWith("");
      expect(screen.queryByTestId("motion-input")).toBeNull();
    });

    it("closes quietly without committing when Enter is pressed on an unchanged value", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId<HTMLInputElement>("motion-input");

      // editValue starts as "Test Agent" — unchanged on first Enter must not
      // commit (an accidental Enter would otherwise lock a stale title).
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onRename).not.toHaveBeenCalled();
      expect(screen.queryByTestId("motion-input")).toBeNull();
    });

    it("commits and exits edit mode when Enter is pressed on a valid changed value", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId<HTMLInputElement>("motion-input");

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onRename).toHaveBeenCalledWith("Renamed");
      expect(screen.queryByTestId("motion-input")).toBeNull();
    });

    it("ignores Enter while an IME composition is in progress", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId<HTMLInputElement>("motion-input");

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });

      expect(onRename).not.toHaveBeenCalled();
      expect(screen.getByTestId("motion-input")).toBe(input);
    });

    it("cancels without committing on Escape", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId<HTMLInputElement>("motion-input");

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(onRename).not.toHaveBeenCalled();
      expect(screen.queryByTestId("motion-input")).toBeNull();
    });

    it("cancels (not resets) when blurring with an empty value", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId<HTMLInputElement>("motion-input");

      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);

      // Blur-empty intent is ambiguous — only an explicit Enter resets.
      expect(onRename).not.toHaveBeenCalled();
      expect(screen.queryByTestId("motion-input")).toBeNull();
    });

    it("commits a changed value on blur", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId<HTMLInputElement>("motion-input");

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.blur(input);

      expect(onRename).toHaveBeenCalledWith("Renamed");
      expect(screen.queryByTestId("motion-input")).toBeNull();
    });
  });

  describe("context-menu rename path", () => {
    it("commits a rename triggered via daintree:rename-terminal even after a prior Escape", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      // First rename via double-click, then Escape — sets the commit-or-cancel guard.
      fireEvent.doubleClick(screen.getByText("Test Agent"));
      const firstInput = screen.getByTestId("motion-input") as HTMLInputElement;
      fireEvent.keyDown(firstInput, { key: "Escape" });
      expect(screen.queryByTestId("motion-input")).toBeNull();

      // Now trigger rename via context-menu event. Without resetting the guard
      // in the event handler, a follow-up blur would silently drop the change.
      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:rename-terminal", { detail: { id: "test-panel-1" } })
        );
      });

      const input = screen.getByTestId<HTMLInputElement>("motion-input");
      fireEvent.change(input, { target: { value: "FromContextMenu" } });
      fireEvent.blur(input);

      expect(onRename).toHaveBeenCalledWith("FromContextMenu");
    });
  });

  // The state indicator must rise and fall with the agent chrome, plus stay
  // visible during the identity-boot window where state can arrive before the
  // chrome commits (#6650). Once chrome is live, the indicator never silently
  // disappears mid-flight: idle/missing/completed state coerces to waiting, and
  // exit/non-agent chrome hides it.
  describe("state indicator visibility", () => {
    // The state icon is the only element that combines "shrink-0" with
    // "motion-reduce:animate-none" (TabButton.tsx). That class combo is a
    // stable identifier across all six AgentState values.
    // The working glyph is a CSS-drawn span, the other states are svgs.
    const queryStateIcon = (container: Element) =>
      Array.from(container.querySelectorAll(GLYPH_SELECTOR)).find((glyph) => {
        const cls = glyph.getAttribute("class") ?? "";
        return cls.includes("motion-reduce:animate-none");
      });

    it("renders working spinner when agentState='working' even with non-agent chrome", () => {
      const { container } = render(
        <TabButton {...defaultProps} chrome={deriveTerminalChrome()} agentState="working" />
      );
      const spinner = container.querySelector(".text-state-working");
      expect(spinner).not.toBeNull();
      // The helper the negative cases below rely on has to see this glyph.
      expect(queryStateIcon(container)).toBe(spinner);
    });

    it("does not render state icon when agentState='exited'", () => {
      const { container } = render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ launchAgentId: "claude" })}
          agentState="exited"
        />
      );
      expect(queryStateIcon(container)).toBeUndefined();
    });

    afterEach(() => {
      useFleetSnapshotStore.setState({ snapshot: null });
    });

    /** The fleet reporting the tab's run, so its band is known. */
    function deliverRun(overrides: Partial<FleetRunRow>) {
      act(() => {
        useFleetSnapshotStore.getState().applySnapshot({
          runs: [
            { runId: defaultProps.id, workspaceId: "p1", spawnedAt: 1, cwd: "/repo", ...overrides },
          ],
          changedAt: 2,
          degraded: false,
          lastSuccessfulAt: 2,
        });
      });
    }

    const UNREAD_ASK = { kind: "asked", quote: "Run it?", readAt: 1, seen: false } as const;

    it.each(["idle", "completed", undefined] as const)(
      "draws no glyph for a live agent at a prompt (%s) that asks nothing",
      (agentState) => {
        const { container } = render(
          <TabButton
            {...defaultProps}
            chrome={deriveTerminalChrome({ launchAgentId: "claude" })}
            agentState={agentState}
          />
        );
        expect(queryStateIcon(container)).toBeUndefined();
        deliverRun({ agentState: "waiting" });
        expect(queryStateIcon(container)).toBeUndefined();
      }
    );

    it("draws the amber ring only for an unread Canopy ask, on a finished turn too", () => {
      deliverRun({ agentState: "completed", canopy: UNREAD_ASK });
      const { container } = render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ launchAgentId: "claude" })}
          agentState="completed"
        />
      );
      expect(container.querySelector(".text-state-waiting")).not.toBeNull();
      expect(screen.getByRole("tab", { name: /Agent waiting/ })).not.toBeNull();
    });

    it("draws an ask amber on live agent chrome before the pane reports any state", () => {
      // The boot window: agent chrome is live, the pane has observed nothing yet.
      deliverRun({ agentState: "waiting", canopy: UNREAD_ASK });
      const { container } = render(
        <TabButton {...defaultProps} chrome={deriveTerminalChrome({ launchAgentId: "claude" })} />
      );
      expect(container.querySelector(".text-state-waiting")).not.toBeNull();
      expect(screen.getByRole("tab", { name: /Agent waiting/ })).not.toBeNull();
    });

    it("draws a hand-back unread, then finished once read, and an error wait blocked", () => {
      const chrome = deriveTerminalChrome({ launchAgentId: "claude" });
      const { container } = render(
        <TabButton {...defaultProps} chrome={chrome} agentState="waiting" />
      );
      deliverRun({ agentState: "waiting", handBack: { stoppedAt: 1 } });
      expect(screen.getByRole("tab", { name: /Agent unread/ })).not.toBeNull();
      deliverRun({ agentState: "waiting", handBack: { stoppedAt: 1, seenAt: 2 } });
      expect(screen.getByRole("tab", { name: /Agent finished/ })).not.toBeNull();
      deliverRun({ agentState: "waiting", waitingReason: "error" });
      expect(screen.getByRole("tab", { name: /Agent blocked/ })).not.toBeNull();
      expect(container.querySelector(".text-state-waiting")).toBeNull();
    });

    it("does not render state icon when agentState is undefined (plain shell)", () => {
      const { container } = render(<TabButton {...defaultProps} chrome={deriveTerminalChrome()} />);
      expect(queryStateIcon(container)).toBeUndefined();
    });

    // #10024 — the visual state icon is aria-hidden, so a visually-hidden text
    // alternative carries the agent state into the tab's accessible name.
    it("includes the agent state in the tab's accessible name when a state is shown", () => {
      render(<TabButton {...defaultProps} chrome={deriveTerminalChrome()} agentState="working" />);
      // getByRole name computation proves the sr-only span lives inside the
      // role="tab" element and participates in the accessible name alongside
      // the visible title — queryByText alone wouldn't guarantee that.
      expect(screen.getByRole("tab", { name: /Test Agent.*Agent working/ })).not.toBeNull();
    });

    it("uses the effective state label when state is coerced (idle -> waiting)", () => {
      deliverRun({ agentState: "waiting", canopy: UNREAD_ASK });
      render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ launchAgentId: "claude" })}
          agentState="idle"
        />
      );
      expect(screen.getByRole("tab", { name: /Agent waiting/ })).not.toBeNull();
    });

    it("does not expose state text when no state is shown (plain shell)", () => {
      render(<TabButton {...defaultProps} chrome={deriveTerminalChrome()} />);
      expect(screen.queryByText(/^Agent /)).toBeNull();
    });

    it("suppresses state text when the agent chrome has exited (stale state)", () => {
      render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ launchAgentId: "claude", exitCode: 0 })}
          agentState="working"
        />
      );
      expect(screen.queryByText(/^Agent /)).toBeNull();
    });
  });

  describe("keyboard drag pickup composition", () => {
    it("activates an inactive tab on Space instead of forwarding to the sortable sensor", () => {
      const onClick = vi.fn();
      const sensorKeyDown = vi.fn();
      render(
        <TabButton
          {...defaultProps}
          isActive={false}
          onClick={onClick}
          sortableListeners={{ onKeyDown: sensorKeyDown }}
        />
      );
      fireEvent.keyDown(screen.getByRole("tab"), { key: " " });
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(sensorKeyDown).not.toHaveBeenCalled();
    });

    it("forwards Space/Enter on the active tab to the sortable keydown so dnd-kit can pick it up", () => {
      const onClick = vi.fn();
      const sensorKeyDown = vi.fn();
      render(
        <TabButton
          {...defaultProps}
          isActive
          onClick={onClick}
          sortableListeners={{ onKeyDown: sensorKeyDown }}
        />
      );
      fireEvent.keyDown(screen.getByRole("tab"), { key: "Enter" });
      expect(sensorKeyDown).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });

    it("keeps Space activation on the active tab when no sortable listeners are wired", () => {
      const onClick = vi.fn();
      render(<TabButton {...defaultProps} isActive onClick={onClick} />);
      fireEvent.keyDown(screen.getByRole("tab"), { key: " " });
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("pointer drag composition (issue #10443)", () => {
    it("stops the tab pointerdown from bubbling to the parent panel drag surface", () => {
      const parentPointerDown = vi.fn();
      const sensorPointerDown = vi.fn();
      render(
        <div onPointerDown={parentPointerDown}>
          <TabButton {...defaultProps} sortableListeners={{ onPointerDown: sensorPointerDown }} />
        </div>
      );
      fireEvent.pointerDown(screen.getByRole("tab"));
      // Guard stops propagation so the parent panel-move drag is never armed...
      expect(parentPointerDown).not.toHaveBeenCalled();
      // ...but the inner tab sortable sensor still receives the pointerdown so
      // tab reorder can pick up. This proves the spread no longer clobbers it.
      expect(sensorPointerDown).toHaveBeenCalledTimes(1);
    });

    it("does not route the close button pointerdown through the sortable sensor", () => {
      const parentPointerDown = vi.fn();
      const sensorPointerDown = vi.fn();
      render(
        <div onPointerDown={parentPointerDown}>
          <TabButton
            {...defaultProps}
            onClose={vi.fn()}
            sortableListeners={{ onPointerDown: sensorPointerDown }}
          />
        </div>
      );
      fireEvent.pointerDown(screen.getByLabelText("Close Test Agent"));
      // Close button is not a drag activator: it stops propagation outright and
      // must NOT pick up a tab drag, so neither the parent nor the sortable fire.
      expect(parentPointerDown).not.toHaveBeenCalled();
      expect(sensorPointerDown).not.toHaveBeenCalled();
    });

    it("still stops propagation when no sortable listeners are wired", () => {
      const parentPointerDown = vi.fn();
      render(
        <div onPointerDown={parentPointerDown}>
          <TabButton {...defaultProps} />
        </div>
      );
      fireEvent.pointerDown(screen.getByRole("tab"));
      expect(parentPointerDown).not.toHaveBeenCalled();
    });

    // Selecting text in the rename field must never pick a tab up. The tab
    // sortable listens on BOTH pointerdown and touchstart (its DndContext pairs
    // PointerSensor with a raw TouchSensor that ignores the strip's
    // [data-no-dnd]), so the input has to stop each one.
    it.each([
      ["pointerdown", (el: HTMLElement) => fireEvent.pointerDown(el), "onPointerDown"],
      ["touchstart", (el: HTMLElement) => fireEvent.touchStart(el), "onTouchStart"],
    ])("does not arm a tab drag from a %s inside the rename input", (_name, fire, listener) => {
      const parentHandler = vi.fn();
      const sensorHandler = vi.fn();
      render(
        <div onPointerDown={parentHandler} onTouchStart={parentHandler}>
          <TabButton
            {...defaultProps}
            onRename={vi.fn()}
            sortableListeners={{ [listener]: sensorHandler }}
          />
        </div>
      );

      fireEvent.doubleClick(screen.getByText("Test Agent"));
      fire(screen.getByTestId("motion-input"));

      expect(sensorHandler).not.toHaveBeenCalled();
      expect(parentHandler).not.toHaveBeenCalled();
    });
  });

  describe("rename field", () => {
    it.each(["Enter", "Escape"])("hands focus back to its tab on %s", async (key) => {
      render(<TabButton {...defaultProps} onRename={vi.fn()} />);
      fireEvent.doubleClick(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input");
      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      expect(document.activeElement).toBe(screen.getByRole("tab"));
    });

    it("opens from F2 on the focused tab without activating it, and ends back on the tab", async () => {
      const onClick = vi.fn();
      const sensor = vi.fn();
      render(
        <TabButton
          {...defaultProps}
          onClick={onClick}
          onRename={vi.fn()}
          sortableListeners={{ onKeyDown: sensor }}
        />
      );
      const tab = screen.getByRole("tab");
      tab.focus();
      const notCancelled = fireEvent.keyDown(tab, { key: "F2" });
      expect(notCancelled).toBe(false);
      const input = screen.getByTestId<HTMLInputElement>("motion-input");
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("Test Agent");
      expect(onClick).not.toHaveBeenCalled();
      expect(sensor).not.toHaveBeenCalled();

      fireEvent.keyDown(input, { key: "Escape" });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      expect(screen.queryByTestId("motion-input")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("tab"));
    });

    it("leaves F2 alone on a tab that cannot be renamed", () => {
      render(<TabButton {...defaultProps} />);
      const tab = screen.getByRole("tab");
      expect(fireEvent.keyDown(tab, { key: "F2" })).toBe(true);
      expect(screen.queryByTestId("motion-input")).toBeNull();
      expect(tab.getAttribute("aria-keyshortcuts")?.split(" ")).not.toContain("F2");
    });

    it("advertises F2 only where it works", () => {
      render(<TabButton {...defaultProps} onRename={vi.fn()} />);
      expect(screen.getByRole("tab").getAttribute("aria-keyshortcuts")?.split(" ")).toContain("F2");
    });

    it("wears the shared inline rename look and treats the name as an identifier", () => {
      render(<TabButton {...defaultProps} onRename={vi.fn()} />);
      fireEvent.doubleClick(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input");
      const classes = input.className.split(/\s+/);
      for (const token of inlineRenameFieldClassName.split(/\s+/)) {
        expect(classes).toContain(token);
      }
      expect(input.getAttribute("spellcheck")).toBe("false");
      expect(input.getAttribute("autocomplete")).toBe("off");
    });

    it("sits beside the tab rather than inside it", () => {
      // A focusable input inside `role="tab"` is the nesting ARIA forbids.
      render(<TabButton {...defaultProps} onRename={vi.fn()} />);
      fireEvent.doubleClick(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input");
      expect(input.closest('[role="tab"]')).toBeNull();
      expect(input.parentElement!.contains(screen.getByRole("tab"))).toBe(true);
    });
  });

  describe("close control", () => {
    it("never takes focus or joins the tab's accessible subtree — Delete is the keyboard route", () => {
      // A focusable control inside a `tab` is the nesting ARIA forbids, and its label
      // would otherwise be read as part of the tab's name.
      for (const isActive of [true, false]) {
        const { container, unmount } = render(<TabButton {...defaultProps} isActive={isActive} />);
        const close = container.querySelector<HTMLElement>("[data-document-tab-close]")!;
        expect(close.tabIndex).toBe(-1);
        expect(close.getAttribute("aria-hidden")).toBe("true");
        expect(screen.getByRole("tab").getAttribute("aria-keyshortcuts")).toBe("Delete");
        unmount();
      }
    });
  });

  describe("tabs pattern relationships", () => {
    it("carries an id and points aria-controls at the region it switches", () => {
      render(<TabButton {...defaultProps} tabPanelId="panel-body-x" />);
      const tab = screen.getByRole("tab");
      expect(tab.id).not.toBe("");
      expect(tab.getAttribute("aria-controls")).toBe("panel-body-x");
    });
  });

  describe("parked tabs", () => {
    it("stays in layout but is not painted while parked", () => {
      render(<TabButton {...defaultProps} isActive={false} parked />);
      const tab = screen.getByRole("tab", { hidden: true });
      // `visibility: hidden` keeps the box for the overflow observer to measure
      // and keeps pointer and focus off a tab the user cannot see.
      expect(tab.classList.contains("invisible")).toBe(true);
      expect(tab.getAttribute("data-tab-parked")).toBe("true");
    });
  });
});
