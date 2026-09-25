// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const tooltipProps = vi.fn();
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children, ...props }: { children: React.ReactNode; autoDismiss?: boolean }) => {
    tooltipProps(props);
    return <>{children}</>;
  },
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const dispatchMock = vi.fn().mockResolvedValue({ ok: true, result: undefined });
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

import { HostMemoryPauseIndicator } from "../HostMemoryPauseIndicator";
import { useHostMemoryPauseStore } from "@/store/hostMemoryPauseStore";
import { HOST_MEMORY_PAUSE_COPY } from "@/lib/hostMemoryPauseCopy";

beforeEach(() => {
  dispatchMock.mockClear();
  useHostMemoryPauseStore.setState({ snapshot: null, visible: false });
});

afterEach(() => {
  cleanup();
});

describe("HostMemoryPauseIndicator", () => {
  it("renders nothing until the pause has cleared the display gate", () => {
    useHostMemoryPauseStore.setState({
      snapshot: { active: true, paused: true, stalled: false },
      visible: false,
    });

    const { container } = render(<HostMemoryPauseIndicator />);

    expect(container.firstChild).toBeNull();
  });

  it("renders one toolbar item describing the paused output", () => {
    useHostMemoryPauseStore.setState({
      snapshot: { active: true, paused: true, stalled: false },
      visible: true,
    });

    const { container } = render(<HostMemoryPauseIndicator />);

    expect(container.querySelectorAll("[data-toolbar-item]")).toHaveLength(1);
    const button = screen.getByTestId("host-memory-pause-indicator");
    expect(button.getAttribute("aria-label")).toBe(HOST_MEMORY_PAUSE_COPY.paused.ariaLabel);
    expect(screen.getByTestId("tooltip-content").textContent).toContain(
      HOST_MEMORY_PAUSE_COPY.paused.title
    );
  });

  it("switches to the still-high reading once output resumes inside the episode", () => {
    useHostMemoryPauseStore.setState({
      snapshot: { active: true, paused: false, stalled: false },
      visible: true,
    });

    render(<HostMemoryPauseIndicator />);

    const button = screen.getByTestId("host-memory-pause-indicator");
    expect(button.getAttribute("aria-label")).toBe(HOST_MEMORY_PAUSE_COPY.monitoring.ariaLabel);
    expect(screen.getByTestId("tooltip-content").textContent).toContain(
      HOST_MEMORY_PAUSE_COPY.monitoring.title
    );
  });

  it.each([
    ["paused", true],
    ["resumed", false],
  ] as const)(
    "never blames system memory or claims every terminal stopped (%s)",
    (_label, paused) => {
      useHostMemoryPauseStore.setState({
        snapshot: { active: true, paused, stalled: false },
        visible: true,
      });

      render(<HostMemoryPauseIndicator />);

      const button = screen.getByTestId("host-memory-pause-indicator");
      const text = `${button.getAttribute("aria-label")} ${screen.getByTestId("tooltip-content").textContent}`;
      expect(text).not.toMatch(/system/i);
      expect(text).not.toMatch(/\ball\b|\bevery\b/i);
    }
  );

  it("tells a live pause from a lifted one without the tooltip", () => {
    const pipFor = (paused: boolean) => {
      useHostMemoryPauseStore.setState({
        snapshot: { active: true, paused, stalled: false },
        visible: true,
      });
      const { unmount } = render(<HostMemoryPauseIndicator />);
      const state = screen.getByTestId("host-memory-pause-pip").getAttribute("data-visible");
      unmount();
      return state;
    };

    // The warning pip marks output held right now; a lifted pause drops it.
    expect(pipFor(true)).toBe("true");
    expect(pipFor(false)).toBe("false");
  });

  it("keeps its explanation up for as long as it is hovered or focused", () => {
    useHostMemoryPauseStore.setState({
      snapshot: { active: true, paused: true, stalled: false },
      visible: true,
    });
    tooltipProps.mockClear();

    render(<HostMemoryPauseIndicator />);

    // The shared tooltip otherwise times out after a hint-length window,
    // which is shorter than it takes to read this body (WCAG 1.4.13).
    expect(tooltipProps).toHaveBeenCalled();
    for (const [props] of tooltipProps.mock.calls) expect(props.autoDismiss).toBe(false);
  });

  it("opens Why am I slow? when clicked", () => {
    useHostMemoryPauseStore.setState({
      snapshot: { active: true, paused: true, stalled: false },
      visible: true,
    });

    render(<HostMemoryPauseIndicator />);
    fireEvent.click(screen.getByTestId("host-memory-pause-indicator"));

    expect(dispatchMock).toHaveBeenCalledWith("diagnostics.openWhySlow", undefined, {
      source: "user",
    });
  });
});
