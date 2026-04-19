// @vitest-environment jsdom
/**
 * AgentInstallSection — drives the Settings "Installation"/"Authentication"/
 * "Not launchable" copy block. Covers the tri-state `authConfirmed` signal
 * introduced in issue #5483: `ready + authConfirmed: undefined` should hide
 * the section; `ready + authConfirmed: false` should surface the auth nudge;
 * `installed` (WSL cap) should surface a distinct WSL message and never
 * claim "not signed in".
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { AgentCliDetail } from "@shared/types";

vi.mock("@/lib/agentInstall", () => ({
  getInstallBlocksForCurrentOS: () => null,
}));

vi.mock("@/components/Setup/InstallBlock", () => ({
  InstallBlock: () => null,
}));

vi.mock("@/config/agents", () => ({
  AGENT_DESCRIPTIONS: {},
  getAgentConfig: (id: string) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    icon: () => null,
    color: "#000",
    install: null,
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

vi.mock("lucide-react", () => ({
  RefreshCw: () => <span />,
  ExternalLink: () => <span />,
}));

import { AgentInstallSection } from "../AgentCard";

function renderSection(overrides: Partial<React.ComponentProps<typeof AgentInstallSection>> = {}) {
  const props: React.ComponentProps<typeof AgentInstallSection> = {
    agentId: "claude",
    agentName: "Claude",
    availability: "ready",
    detail: undefined,
    isCliLoading: false,
    isRefreshingCli: false,
    cliError: null,
    onRefresh: () => {},
    ...overrides,
  };
  return render(<AgentInstallSection {...props} />);
}

describe("AgentInstallSection tri-state rendering", () => {
  it("hides the whole section when ready and authConfirmed is undefined", () => {
    const detail: AgentCliDetail = {
      state: "ready",
      resolvedPath: "/usr/local/bin/claude",
      via: "which",
      // no authConfirmed — agent has no authCheck configured
    };
    const { container } = renderSection({ availability: "ready", detail });
    expect(container.textContent).toBe("");
  });

  it("hides the whole section when ready and authConfirmed is true", () => {
    const detail: AgentCliDetail = {
      state: "ready",
      resolvedPath: "/usr/local/bin/claude",
      via: "which",
      authConfirmed: true,
    };
    const { container } = renderSection({ availability: "ready", detail });
    expect(container.textContent).toBe("");
  });

  it("renders the Authentication header when ready and authConfirmed is false", () => {
    const detail: AgentCliDetail = {
      state: "ready",
      resolvedPath: "/usr/local/bin/claude",
      via: "which",
      authConfirmed: false,
    };
    const { container } = renderSection({ availability: "ready", detail });
    expect(container.textContent).toContain("Authentication");
    expect(container.textContent).toContain("not signed in");
  });

  it("renders the WSL 'Not launchable' message for installed WSL agents (not an auth nudge)", () => {
    const detail: AgentCliDetail = {
      state: "installed",
      resolvedPath: "wsl:Ubuntu",
      via: "wsl",
      wslDistro: "Ubuntu",
    };
    const { container } = renderSection({ availability: "installed", detail });
    expect(container.textContent).toContain("Not launchable");
    expect(container.textContent).toContain("WSL");
    // Must NOT claim the user needs to sign in — the issue is launch, not auth.
    expect(container.textContent).not.toContain("not signed in");
  });

  it("renders the Installation header when availability is missing", () => {
    const { container } = renderSection({ availability: "missing", detail: undefined });
    expect(container.textContent).toContain("Installation");
    expect(container.textContent).toContain("CLI not found");
  });

  it("renders the Blocked header when availability is blocked", () => {
    const detail: AgentCliDetail = {
      state: "blocked",
      resolvedPath: "/usr/local/bin/claude",
      via: "which",
      blockReason: "security",
      message: "Blocked by security software",
    };
    const { container } = renderSection({ availability: "blocked", detail });
    expect(container.textContent).toContain("Blocked");
  });
});
