// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { MissingCliGate } from "../MissingCliGate";
import type { AgentCliDetail } from "@shared/types/ipc";

// A hand-rolled store double rather than the real one: the gate reads it both
// as a hook (`refresh`, `isRefreshing`) and imperatively (`getState().availability`),
// and the availability half is what the continuation decision hangs on.
const cliStore = vi.hoisted(() => {
  const state: {
    refresh: (force?: boolean) => Promise<void>;
    isRefreshing: boolean;
    availability: Record<string, string>;
  } = {
    refresh: vi.fn<(force?: boolean) => Promise<void>>(),
    isRefreshing: false,
    availability: {},
  };
  // `Object.assign` rather than an assertion — the store is callable with a
  // selector AND carries `getState`, and the intersection falls out for free.
  const useStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    { getState: () => state }
  );
  return { state, useStore };
});

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: cliStore.useStore,
}));

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

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

function renderGate(
  props: Partial<React.ComponentProps<typeof MissingCliGate>> & { detail: AgentCliDetail }
) {
  const handlers = {
    onRunAnyway: vi.fn(),
    onAvailabilityReady: vi.fn(),
    onOpenAgentSettings: vi.fn(),
  };
  const view = render(<MissingCliGate agentId="claude" {...handlers} {...props} />);
  return { ...view, ...handlers };
}

// `InlineStatusBanner` reads the reduced-motion preference on render, and jsdom
// ships no `matchMedia`. Same stub the banner's own suite installs.
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

describe("MissingCliGate", () => {
  beforeEach(() => {
    mockPlatform.isMac.mockReturnValue(true);
    mockPlatform.isLinux.mockReturnValue(false);
    cliStore.state.refresh = vi.fn<(force?: boolean) => Promise<void>>().mockResolvedValue();
    cliStore.state.isRefreshing = false;
    cliStore.state.availability = {};
  });

  it("renders the agent name", () => {
    renderGate({ detail: detail({ state: "missing" }) });
    expect(screen.getByText("Claude")).toBeTruthy();
  });

  it("shows 'CLI binary not found' for missing state", () => {
    renderGate({ detail: detail({ state: "missing" }) });
    expect(screen.getByText("CLI binary not found")).toBeTruthy();
  });

  it("shows install commands for missing state on macOS", () => {
    renderGate({ detail: detail({ state: "missing" }) });
    expect(screen.getByText("Install on macOS")).toBeTruthy();
    expect(screen.getByText("npm install -g @anthropic-ai/claude-code")).toBeTruthy();
  });

  it("shows troubleshooting tips for missing state", () => {
    renderGate({ detail: detail({ state: "missing" }) });
    expect(screen.getByText("Troubleshooting")).toBeTruthy();
    expect(screen.getByText("Restart Daintree after install")).toBeTruthy();
  });

  it("shows WSL message for installed state via wsl", () => {
    renderGate({ detail: detail({ state: "installed", via: "wsl", wslDistro: "Ubuntu" }) });
    expect(screen.getByText("Detected in WSL")).toBeTruthy();
    expect(
      screen.getByText(/Found in WSL \(Ubuntu\).*only host binaries can be launched directly/)
    ).toBeTruthy();
  });

  it("shows blocked message for blocked state", () => {
    renderGate({ detail: detail({ state: "blocked", message: "EACCES: permission denied" }) });
    expect(screen.getByText("Blocked by security software")).toBeTruthy();
    expect(screen.getByText("EACCES: permission denied")).toBeTruthy();
  });

  it("calls onRunAnyway when 'Run anyway' button is clicked", () => {
    const { onRunAnyway } = renderGate({ detail: detail({ state: "missing" }) });
    fireEvent.click(screen.getByText("Run anyway"));
    expect(onRunAnyway).toHaveBeenCalledOnce();
  });

  it("shows docs link when docsUrl is present", () => {
    renderGate({ detail: detail({ state: "missing" }) });
    expect(screen.getByText("Docs")).toBeTruthy();
  });

  it("shows resolved path when present in detail", () => {
    renderGate({ detail: detail({ state: "missing", resolvedPath: "/usr/local/bin/claude" }) });
    expect(screen.getByText("Last known path: /usr/local/bin/claude")).toBeTruthy();
  });

  it("does not show install commands for installed state", () => {
    renderGate({ detail: detail({ state: "installed", via: "npm-global" }) });
    expect(screen.queryByText("Install on macOS")).toBeNull();
    expect(screen.queryByText("Troubleshooting")).toBeNull();
  });

  it("does not show install commands for blocked state", () => {
    renderGate({ detail: detail({ state: "blocked" }) });
    expect(screen.queryByText("Install on macOS")).toBeNull();
  });

  // `unauthenticated` used to fall through to the blocked branch, sending a
  // user who only needs to sign in hunting through endpoint-security settings.
  it("distinguishes unauthenticated from blocked", () => {
    renderGate({ detail: detail({ state: "unauthenticated" }) });
    expect(screen.getByText("Sign-in not detected")).toBeTruthy();
    expect(screen.queryByText("Blocked by security software")).toBeNull();
  });

  it("routes to the agent's settings without making it the only way out", () => {
    const { onOpenAgentSettings } = renderGate({ detail: detail({ state: "missing" }) });
    fireEvent.click(screen.getByText("Agent settings"));
    expect(onOpenAgentSettings).toHaveBeenCalledOnce();
    // Settings is demoted, not promoted: the recovery actions stay on the panel.
    expect(screen.getByText("Run anyway")).toBeTruthy();
    expect(screen.getByText("Re-check")).toBeTruthy();
  });

  describe("re-check", () => {
    it("forces the probe past the passive throttle window", async () => {
      renderGate({ detail: detail({ state: "missing" }) });
      await act(async () => {
        fireEvent.click(screen.getByText("Re-check"));
      });
      // A user who just installed the CLI is exactly who the throttle blocks.
      expect(cliStore.state.refresh).toHaveBeenCalledWith(true);
    });

    it.each(["ready", "unauthenticated"])(
      "continues the original launch when the probe comes back %s",
      async (state) => {
        cliStore.state.refresh = vi.fn(async () => {
          cliStore.state.availability = { claude: state };
        });
        const { onAvailabilityReady } = renderGate({ detail: detail({ state: "missing" }) });

        await act(async () => {
          fireEvent.click(screen.getByText("Re-check"));
        });

        await waitFor(() => expect(onAvailabilityReady).toHaveBeenCalledOnce());
      }
    );

    it("stays on the gate when the probe still reports it unlaunchable", async () => {
      cliStore.state.refresh = vi.fn(async () => {
        cliStore.state.availability = { claude: "missing" };
      });
      const { onAvailabilityReady, onRunAnyway } = renderGate({
        detail: detail({ state: "missing" }),
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Re-check"));
      });

      expect(onAvailabilityReady).not.toHaveBeenCalled();
      expect(onRunAnyway).not.toHaveBeenCalled();
      expect(screen.getByText("Re-check")).toBeTruthy();
    });

    it("reads availability rather than details, which a resolved probe may leave stale", async () => {
      // The store swallows a `getDetails` failure and keeps the old details
      // while still resolving, so a details-driven decision would never fire.
      cliStore.state.refresh = vi.fn(async () => {
        cliStore.state.availability = { claude: "ready" };
      });
      const { onAvailabilityReady } = renderGate({
        detail: detail({ state: "missing" }),
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Re-check"));
      });

      await waitFor(() => expect(onAvailabilityReady).toHaveBeenCalledOnce());
    });

    it("surfaces a failed probe inline and keeps the recovery actions", async () => {
      cliStore.state.refresh = vi.fn().mockRejectedValue(new Error("IPC down"));
      const { onAvailabilityReady } = renderGate({ detail: detail({ state: "missing" }) });

      await act(async () => {
        fireEvent.click(screen.getByText("Re-check"));
      });

      await waitFor(() => expect(screen.getByText("Couldn't re-check the CLI")).toBeTruthy());
      expect(onAvailabilityReady).not.toHaveBeenCalled();
      expect(screen.getByText("Run anyway")).toBeTruthy();
    });

    // Two independent stops, asserted separately — a disabled button alone
    // would hide a missing guard, and the guard alone would let a
    // programmatic/Enter-during-transition press through.
    it("disables the control while a probe is in flight", () => {
      cliStore.state.isRefreshing = true;
      renderGate({ detail: detail({ state: "missing" }) });

      expect(screen.getByText("Re-check").closest("button")?.disabled).toBe(true);
    });

    it("refuses a second probe even when the disabled control is bypassed", async () => {
      let inFlight = 0;
      cliStore.state.refresh = vi.fn(() => {
        inFlight += 1;
        // Mirror the store flipping its flag for the duration of the probe.
        cliStore.state.isRefreshing = true;
        return Promise.resolve();
      });
      renderGate({ detail: detail({ state: "missing" }) });
      const button = screen.getByText("Re-check").closest("button")!;

      await act(async () => {
        // `click()` bypasses the disabled attribute the way a stale render or a
        // keyboard press mid-transition can; only the guard stops this one.
        button.click();
        button.click();
      });

      expect(inFlight).toBe(1);
    });

    it("does not continue a launch into a panel that closed mid-probe", async () => {
      let settle: (() => void) | undefined;
      cliStore.state.refresh = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            settle = () => {
              cliStore.state.availability = { claude: "ready" };
              resolve();
            };
          })
      );
      const { onAvailabilityReady, unmount } = renderGate({ detail: detail({ state: "missing" }) });

      fireEvent.click(screen.getByText("Re-check"));
      unmount();
      await act(async () => {
        settle?.();
      });

      expect(onAvailabilityReady).not.toHaveBeenCalled();
    });
  });
});
