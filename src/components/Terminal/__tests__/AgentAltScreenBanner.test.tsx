// @vitest-environment jsdom
import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentAltScreenBanner } from "../AgentAltScreenBanner";
import { WindowControlsInsetProvider } from "@/components/ui/WindowControlsInset";
import { getAgentConfig } from "@/config/agents";
import { getAgentInlineSupport } from "@/lib/agentInlineMode";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The copy variants are driven by what an agent declares, so those tests state
// it themselves; one test below keeps the real registry for Claude Code.
vi.mock("@/lib/agentInlineMode", () => ({ getAgentInlineSupport: vi.fn() }));
const realInlineMode =
  await vi.importActual<typeof import("@/lib/agentInlineMode")>("@/lib/agentInlineMode");

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

const UNKNOWN_AGENT = "acme-agent";

beforeEach(() => {
  vi.mocked(getAgentInlineSupport).mockReset();
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

const MEANING = "Daintree's scrollback and search don't apply to this terminal";
const DISMISS = "Dismiss full-screen notice";

describe("AgentAltScreenBanner", () => {
  it("names the agent and says what full-screen means for this pane", () => {
    vi.mocked(getAgentInlineSupport).mockReturnValue({ supported: false });
    const { container } = renderBanner(UNKNOWN_AGENT);

    expect(screen.getByText(`${UNKNOWN_AGENT} is running full-screen`)).not.toBeNull();
    expect(container.textContent).toContain(MEANING);
  });

  it("uses the agent's display name when the registry has one", () => {
    vi.mocked(getAgentInlineSupport).mockReturnValue({ supported: false });
    renderBanner("claude");

    expect(
      screen.getByText(`${getAgentConfig("claude")?.name} is running full-screen`)
    ).not.toBeNull();
  });

  it("is an informational status, not an alert", () => {
    vi.mocked(getAgentInlineSupport).mockReturnValue({ supported: false });
    const { container } = renderBanner(UNKNOWN_AGENT);

    const root = container.querySelector("[data-inline-status-banner]");
    expect(root?.getAttribute("role")).toBe("status");
    expect(root?.getAttribute("aria-live")).toBe("polite");
  });

  it("gives a full-screen-only agent no inline-mode recommendation", () => {
    vi.mocked(getAgentInlineSupport).mockReturnValue({ supported: false });
    const { container } = renderBanner(UNKNOWN_AGENT);

    expect(container.textContent).not.toMatch(/inline/i);
    expect(container.querySelector("code")).toBeNull();
  });

  it("says inline mode is supported for an agent that has one", () => {
    vi.mocked(getAgentInlineSupport).mockReturnValue({ supported: true });
    const { container } = renderBanner(UNKNOWN_AGENT);

    expect(container.textContent).toContain(`${MEANING}. ${UNKNOWN_AGENT} supports inline mode.`);
    expect(container.querySelector("code")).toBeNull();
  });

  it("names the command that switches the CLI back when the agent has one", () => {
    vi.mocked(getAgentInlineSupport).mockReturnValue({ supported: true, command: "/inline now" });
    const { container } = renderBanner(UNKNOWN_AGENT);

    expect(container.textContent).toContain(
      `${UNKNOWN_AGENT} supports inline mode with /inline now.`
    );
    expect(container.querySelector("code")?.textContent).toBe("/inline now");
  });

  it("names /tui default for Claude Code from the real registry", () => {
    vi.mocked(getAgentInlineSupport).mockImplementation(realInlineMode.getAgentInlineSupport);
    const { container } = renderBanner("claude");

    expect(container.querySelector("code")?.textContent).toBe("/tui default");
    expect(container.textContent).toContain("supports inline mode with /tui default.");
  });

  it("dismisses without activating the pane", () => {
    vi.mocked(getAgentInlineSupport).mockReturnValue({ supported: false });
    const { onDismiss, onPaneClick } = renderBanner(UNKNOWN_AGENT);

    fireEvent.click(screen.getByRole("button", { name: DISMISS }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onPaneClick).not.toHaveBeenCalled();
  });
});
