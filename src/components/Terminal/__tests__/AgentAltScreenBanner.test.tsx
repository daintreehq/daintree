// @vitest-environment jsdom
import React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentAltScreenBanner } from "../AgentAltScreenBanner";
import { WindowControlsInsetProvider } from "@/components/ui/WindowControlsInset";
import { getAgentConfig } from "@/config/agents";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// jsdom ships no `matchMedia`, and `InlineStatusBanner` reads it while rendering.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function renderBanner(agentId: string) {
  const onDismiss = vi.fn();
  // Stands in for TerminalPane, whose shell focuses the pane on click.
  const onPaneClick = vi.fn();
  const result = render(
    <WindowControlsInsetProvider>
      <div onClick={onPaneClick}>
        <AgentAltScreenBanner agentId={agentId} onDismiss={onDismiss} />
      </div>
    </WindowControlsInsetProvider>
  );
  return { ...result, onDismiss, onPaneClick };
}

const MEANING = "Daintree's scrollback and search don't apply to this pane";
const DISMISS = "Dismiss full-screen notice";

describe("AgentAltScreenBanner", () => {
  it("names the agent and says what full-screen means for this pane", () => {
    const { container } = renderBanner("crush");

    expect(
      screen.getByText(`${getAgentConfig("crush")?.name} is running full-screen`)
    ).not.toBeNull();
    expect(container.textContent).toContain(MEANING);
  });

  it("is an informational status, not an alert", () => {
    const { container } = renderBanner("crush");

    const root = container.querySelector("[data-inline-status-banner]");
    expect(root?.getAttribute("role")).toBe("status");
    expect(root?.getAttribute("aria-live")).toBe("polite");
  });

  it("gives a full-screen-only agent no inline-mode recommendation", () => {
    const { container } = renderBanner("crush");

    expect(container.textContent).not.toMatch(/inline/i);
    expect(container.querySelector("code")).toBeNull();
  });

  it("says inline mode is supported for an agent that has one", () => {
    const { container } = renderBanner("codex");

    expect(container.textContent).toContain(
      `${MEANING}. ${getAgentConfig("codex")?.name} supports inline mode.`
    );
    expect(container.querySelector("code")).toBeNull();
  });

  it("names the command that switches Claude Code back to the main screen", () => {
    const { container } = renderBanner("claude");

    expect(container.textContent).toContain(
      `${getAgentConfig("claude")?.name} supports inline mode with /tui default.`
    );
    expect(container.querySelector("code")?.textContent).toBe("/tui default");
  });

  it("falls back to the id for an agent the registry does not know", () => {
    renderBanner("mystery-agent");

    expect(screen.getByText("mystery-agent is running full-screen")).not.toBeNull();
  });

  it("dismisses without activating the pane", () => {
    const { onDismiss, onPaneClick } = renderBanner("crush");

    fireEvent.click(screen.getByRole("button", { name: DISMISS }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onPaneClick).not.toHaveBeenCalled();
  });
});
