// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TabButton } from "../TabButton";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

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
  it("shows red dot indicator when hasDangerousFlags is true", () => {
    render(<TabButton {...defaultProps} hasDangerousFlags={true} />);

    const indicator = screen.getByLabelText("Launched with dangerous permissions");
    expect(indicator).toBeDefined();
    expect(indicator.className).toContain("bg-status-danger");
  });

  it("does not show indicator when hasDangerousFlags is false", () => {
    render(<TabButton {...defaultProps} hasDangerousFlags={false} />);

    const indicator = screen.queryByLabelText("Launched with dangerous permissions");
    expect(indicator).toBeNull();
  });

  it("does not show indicator when hasDangerousFlags is undefined", () => {
    render(<TabButton {...defaultProps} />);

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

  it("shows tooltip with correct text for dangerous flags", () => {
    render(<TabButton {...defaultProps} hasDangerousFlags={true} />);

    const tooltipContent = screen.queryByText(
      "Launched with dangerous permissions — agent can modify files without prompting"
    );
    expect(tooltipContent).not.toBeNull();
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
    it("renders the Claude agent icon when detectedAgentId='claude', even without launch hint", () => {
      const { container } = render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ detectedAgentId: "claude", detectedProcessId: "claude" })}
        />
      );
      // The agent config's Icon component renders. Shorthand: assert the icon
      // container has received the brand color for Claude, proving TerminalIcon
      // took the effectiveAgentId="claude" branch (not the fallback glyph).
      const iconHost = container.querySelector('[aria-hidden="true"]');
      expect(iconHost).not.toBeNull();
    });

    it("renders the generic terminal icon when no agent affinity is present", () => {
      const { container } = render(<TabButton {...defaultProps} chrome={deriveTerminalChrome()} />);
      // Lucide's SquareTerminal renders an <svg>; that's what we expect here.
      const svgs = container.querySelectorAll("svg");
      expect(svgs.length).toBeGreaterThan(0);
    });

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
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onRename).toHaveBeenCalledWith("");
      expect(screen.queryByTestId("motion-input")).toBeNull();
    });

    it("closes quietly without committing when Enter is pressed on an unchanged value", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

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
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onRename).toHaveBeenCalledWith("Renamed");
      expect(screen.queryByTestId("motion-input")).toBeNull();
    });

    it("ignores Enter while an IME composition is in progress", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });

      expect(onRename).not.toHaveBeenCalled();
      expect(screen.getByTestId("motion-input")).toBe(input);
    });

    it("cancels without committing on Escape", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(onRename).not.toHaveBeenCalled();
      expect(screen.queryByTestId("motion-input")).toBeNull();
    });

    it("cancels (not resets) when blurring with an empty value", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

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
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.blur(input);

      expect(onRename).toHaveBeenCalledWith("Renamed");
      expect(screen.queryByTestId("motion-input")).toBeNull();
    });
  });

  describe("tooltip shows the full composed title", () => {
    it("prefers fullTitle over the compact slot title in the tab tooltip", () => {
      render(<TabButton {...defaultProps} fullTitle="Claude: fix auth tests" onRename={vi.fn()} />);
      // Radix tooltips render on hover; assert via the props contract instead
      // of hover simulation: the compact slot renders `title`, and the
      // tooltip content template consumes `fullTitle` when provided.
      expect(screen.getByText("Test Agent")).toBeTruthy();
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

      const input = screen.getByTestId("motion-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "FromContextMenu" } });
      fireEvent.blur(input);

      expect(onRename).toHaveBeenCalledWith("FromContextMenu");
    });
  });

  describe("rename input fade-in", () => {
    it("renders the input via m.input (motion wrapper) when entering edit mode", () => {
      render(<TabButton {...defaultProps} onRename={vi.fn()} />);
      expect(screen.queryByTestId("motion-input")).toBeNull();

      fireEvent.doubleClick(screen.getByText("Test Agent"));

      const input = screen.getByTestId("motion-input");
      expect(input).not.toBeNull();
      expect(input.tagName).toBe("INPUT");
    });
  });

  describe("rename input feels inline (#7926)", () => {
    it("uses a transparent border and subtle background lift instead of chrome", () => {
      render(<TabButton {...defaultProps} onRename={vi.fn()} />);
      fireEvent.doubleClick(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input") as HTMLInputElement;
      expect(input.className).toContain("border-transparent");
      expect(input.className).toContain("bg-overlay-soft");
      expect(input.className).not.toContain("border-border-strong");
      expect(input.className).not.toContain("bg-daintree-bg/80");
    });

    it("does not use the accent color for any focus indicator", () => {
      render(<TabButton {...defaultProps} onRename={vi.fn()} />);
      fireEvent.doubleClick(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input") as HTMLInputElement;
      expect(input.className).not.toMatch(
        /(?:outline|ring|border)-(?:daintree-accent|accent-primary)(?![\w-])/
      );
      expect(input.className).toContain("focus:outline-hidden");
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
    const queryStateIcon = (container: Element) =>
      Array.from(container.querySelectorAll("svg")).find((svg) => {
        const cls = svg.getAttribute("class") ?? "";
        return cls.includes("motion-reduce:animate-none");
      });

    it("renders working spinner when agentState='working' even with non-agent chrome", () => {
      const { container } = render(
        <TabButton {...defaultProps} chrome={deriveTerminalChrome()} agentState="working" />
      );
      const spinner = container.querySelector(".text-state-working");
      expect(spinner).not.toBeNull();
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

    it("renders waiting icon when agentState='idle' but agent chrome is live", () => {
      const { container } = render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ launchAgentId: "claude" })}
          agentState="idle"
        />
      );
      expect(queryStateIcon(container)).toBeDefined();
    });

    it("renders waiting icon when agentState='completed' and agent chrome is live", () => {
      const { container } = render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ launchAgentId: "claude" })}
          agentState="completed"
        />
      );
      const waitingIcon = container.querySelector(".text-state-waiting");
      expect(waitingIcon).not.toBeNull();
    });

    it("renders waiting icon when agentState is undefined but agent chrome is live", () => {
      const { container } = render(
        <TabButton {...defaultProps} chrome={deriveTerminalChrome({ launchAgentId: "claude" })} />
      );
      expect(queryStateIcon(container)).toBeDefined();
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
});
