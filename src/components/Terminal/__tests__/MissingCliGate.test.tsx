// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MissingCliGate } from "../MissingCliGate";
import type { AgentCliDetail } from "@shared/types/ipc";

// Mock platform detection
const mockPlatform = vi.hoisted(() => ({
  isMac: vi.fn(() => true),
  isLinux: vi.fn(() => false),
}));

vi.mock("@/lib/platform", () => ({
  isMac: () => mockPlatform.isMac(),
  isLinux: () => mockPlatform.isLinux(),
}));

// Mock cn utility to pass through class names
vi.mock("@/lib/utils", () => ({
  cn: (...args: (string | false | undefined | null)[]) => args.filter(Boolean).join(" "),
}));

// Mock agent config
vi.mock("@/config/agents", () => ({
  getAgentConfig: (agentId: string) => {
    if (agentId === "claude") {
      return {
        id: "claude",
        name: "Claude",
        install: {
          docsUrl: "https://docs.anthropic.com/claude-code",
          byOs: {
            macos: [{ label: "npm", commands: ["npm install -g @anthropic-ai/claude-code"] }],
            linux: [{ label: "npm", commands: ["npm install -g @anthropic-ai/claude-code"] }],
            windows: [{ label: "npm", commands: ["npm install -g @anthropic-ai/claude-code"] }],
          },
          troubleshooting: ["Restart Daintree after install", "Verify with: claude --version"],
        },
      };
    }
    return undefined;
  },
}));

function detail(overrides: Partial<AgentCliDetail> = {}): AgentCliDetail {
  return {
    state: "missing",
    resolvedPath: null,
    via: null,
    ...overrides,
  };
}

describe("MissingCliGate", () => {
  beforeEach(() => {
    mockPlatform.isMac.mockReturnValue(true);
    mockPlatform.isLinux.mockReturnValue(false);
  });

  it("renders the agent name", () => {
    render(
      <MissingCliGate
        agentId="claude"
        detail={detail({ state: "missing" })}
        onRunAnyway={() => {}}
      />
    );
    expect(screen.getByText("Claude")).toBeTruthy();
  });

  it("shows 'CLI binary not found' for missing state", () => {
    render(
      <MissingCliGate
        agentId="claude"
        detail={detail({ state: "missing" })}
        onRunAnyway={() => {}}
      />
    );
    expect(screen.getByText("CLI binary not found")).toBeTruthy();
  });

  it("shows install commands for missing state on macOS", () => {
    render(
      <MissingCliGate
        agentId="claude"
        detail={detail({ state: "missing" })}
        onRunAnyway={() => {}}
      />
    );
    expect(screen.getByText("Install on macOS")).toBeTruthy();
    expect(screen.getByText("npm install -g @anthropic-ai/claude-code")).toBeTruthy();
  });

  it("shows troubleshooting tips for missing state", () => {
    render(
      <MissingCliGate
        agentId="claude"
        detail={detail({ state: "missing" })}
        onRunAnyway={() => {}}
      />
    );
    expect(screen.getByText("Troubleshooting")).toBeTruthy();
    expect(screen.getByText("Restart Daintree after install")).toBeTruthy();
  });

  it("shows WSL message for installed state via wsl", () => {
    render(
      <MissingCliGate
        agentId="claude"
        detail={detail({ state: "installed", via: "wsl", wslDistro: "Ubuntu" })}
        onRunAnyway={() => {}}
      />
    );
    expect(screen.getByText("Detected in WSL")).toBeTruthy();
    expect(
      screen.getByText(/Found in WSL \(Ubuntu\) but Daintree launches binaries directly/)
    ).toBeTruthy();
  });

  it("shows blocked message for blocked state", () => {
    render(
      <MissingCliGate
        agentId="claude"
        detail={detail({ state: "blocked", message: "EACCES: permission denied" })}
        onRunAnyway={() => {}}
      />
    );
    expect(screen.getByText("Blocked by security software")).toBeTruthy();
    expect(screen.getByText("EACCES: permission denied")).toBeTruthy();
  });

  it("calls onRunAnyway when 'Run anyway' button is clicked", () => {
    const onRunAnyway = vi.fn();
    render(
      <MissingCliGate
        agentId="claude"
        detail={detail({ state: "missing" })}
        onRunAnyway={onRunAnyway}
      />
    );
    fireEvent.click(screen.getByText("Run anyway"));
    expect(onRunAnyway).toHaveBeenCalledOnce();
  });

  it("shows docs link when docsUrl is present", () => {
    render(
      <MissingCliGate
        agentId="claude"
        detail={detail({ state: "missing" })}
        onRunAnyway={() => {}}
      />
    );
    expect(screen.getByText("Docs")).toBeTruthy();
  });

  it("shows resolved path when present in detail", () => {
    render(
      <MissingCliGate
        agentId="claude"
        detail={detail({ state: "missing", resolvedPath: "/usr/local/bin/claude" })}
        onRunAnyway={() => {}}
      />
    );
    expect(screen.getByText("Last known path: /usr/local/bin/claude")).toBeTruthy();
  });

  it("does not show install commands for installed state", () => {
    render(
      <MissingCliGate
        agentId="claude"
        detail={detail({ state: "installed", via: "npm-global" })}
        onRunAnyway={() => {}}
      />
    );
    expect(screen.queryByText("Install on macOS")).toBeNull();
    expect(screen.queryByText("Troubleshooting")).toBeNull();
  });

  it("does not show install commands for blocked state", () => {
    render(
      <MissingCliGate
        agentId="claude"
        detail={detail({ state: "blocked" })}
        onRunAnyway={() => {}}
      />
    );
    expect(screen.queryByText("Install on macOS")).toBeNull();
  });
});
