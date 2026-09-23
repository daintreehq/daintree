// @vitest-environment jsdom
/**
 * AgentInstallSection — drives the Settings "Installation"/"Authentication"/
 * "Not launchable" copy block. Covers the tri-state `authConfirmed` signal
 * introduced in issue #5483: `ready + authConfirmed: undefined` should hide
 * the section; `ready + authConfirmed: false` should surface the auth nudge;
 * `installed` (WSL cap) should surface a distinct WSL message and never
 * claim a credential problem.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { AgentCliDetail } from "@shared/types";

const installBlocks = vi.hoisted(() => ({
  current: null as null | { label: string; commands: string[] }[],
}));

vi.mock("@/lib/agentInstall", () => ({
  getInstallBlocksForCurrentOS: () => installBlocks.current,
  extractInspectUrl: () => undefined,
}));

vi.mock("@/components/Setup/InstallBlock", () => ({
  InstallBlock: () => null,
  CopyableCommand: ({ command }: { command: string }) => <code>{command}</code>,
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
  TriangleAlert: () => <span />,
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

  it("names the missing-credentials state when state is unauthenticated", () => {
    const detail: AgentCliDetail = {
      state: "unauthenticated",
      resolvedPath: "/usr/local/bin/claude",
      via: "which",
      authConfirmed: false,
    };
    const { container } = renderSection({ availability: "unauthenticated", detail });
    expect(container.textContent).toContain("No credentials detected");
    // States what the probe saw, and does not promise what launching will do — the
    // state is launchable and the CLI resolves credentials at run time.
    expect(container.textContent).toContain("no credentials were detected");
    expect(container.textContent).not.toMatch(/will prompt/i);
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
    // Must NOT claim a credential problem — the issue is launch, not auth.
    expect(container.textContent).not.toContain("no credentials were detected");
  });

  it("names the missing state and asks for an install when availability is missing", () => {
    const { container } = renderSection({ availability: "missing", detail: undefined });
    expect(container.textContent).toContain("Not installed");
    expect(container.textContent).toContain("Claude CLI isn't on your PATH");
  });

  // A found binary needs a diagnosis, not a reinstall: offering install commands for
  // something already on disk sends the user to fix the wrong thing.
  it.each(["blocked", "unauthenticated", "installed"] as const)(
    "offers install commands only when the CLI is missing, not when it is %s",
    (availability) => {
      installBlocks.current = [{ label: "npm", commands: ["npm install -g claude-cli"] }];
      try {
        const detail: AgentCliDetail = {
          state: availability,
          resolvedPath: "/usr/local/bin/claude",
          via: "which",
          authConfirmed: availability === "unauthenticated" ? false : undefined,
        };
        const found = renderSection({ availability, detail });
        expect(found.container.textContent).not.toContain("npm install -g claude-cli");
        found.unmount();

        const missing = renderSection({ availability: "missing", detail: undefined });
        expect(missing.container.textContent).toContain("npm install -g claude-cli");
      } finally {
        installBlocks.current = null;
      }
    }
  );

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
