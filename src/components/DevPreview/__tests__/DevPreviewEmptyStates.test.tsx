// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { DevPreviewEmptyStates } from "../DevPreviewEmptyStates";
import type { DevServerError } from "@shared/utils/devServerErrors";
import type { RunCommand } from "@shared/types";

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

function baseProps(overrides: Partial<React.ComponentProps<typeof DevPreviewEmptyStates>> = {}) {
  return {
    isRestarting: false,
    status: "running" as const,
    isProxyUrlPending: false,
    phaseLabel: undefined,
    error: null,
    handleRetry: vi.fn(),
    setDevPreviewConsoleOpen: vi.fn(),
    id: "pane-1",
    currentUrl: "http://localhost:3000",
    handleOpenExternal: vi.fn(),
    isUnconfigured: false,
    primaryCandidate: undefined,
    isAutoDetecting: false,
    attemptingCommand: null,
    isSettingsLoading: false,
    handleAutoDetect: vi.fn().mockResolvedValue(true),
    autoDetectFailedCommand: null,
    candidates: [],
    handlePickCandidate: vi.fn(),
    handleOpenSettings: vi.fn(),
    commandInput: "",
    setCommandInput: vi.fn(),
    handleSaveCommand: vi.fn().mockResolvedValue(undefined),
    commandInputError: null,
    isSavingCommand: false,
    saveCommandFailed: false,
    devCommand: "",
    handleStartFromRestored: vi.fn(),
    hasBeenVisible: true,
    isEvicted: false,
    ...overrides,
  };
}

function runner(overrides: Partial<RunCommand> = {}): RunCommand {
  return { id: "dev", name: "dev", command: "npm run dev", ...overrides } as RunCommand;
}

describe("DevPreviewEmptyStates", () => {
  it("renders the loading state while restarting", () => {
    render(<DevPreviewEmptyStates {...baseProps({ isRestarting: true })} />);
    expect(screen.getByText(/restarting/i)).toBeTruthy();
  });

  it("renders the loading state while installing dependencies", () => {
    render(<DevPreviewEmptyStates {...baseProps({ status: "installing" })} />);
    expect(screen.getByText(/installing dependencies/i)).toBeTruthy();
  });

  it("renders the dev-server error state with a retry action", () => {
    const error: DevServerError = { type: "port-conflict", message: "Port 3000 is in use" };
    render(<DevPreviewEmptyStates {...baseProps({ status: "error", error })} />);
    expect(screen.getByText("Port conflict")).toBeTruthy();
    expect(screen.getByText("Port 3000 is in use")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("offers 'View terminal' instead of retry-install copy for a non-dependency error", () => {
    const error: DevServerError = { type: "permission", message: "EACCES" };
    render(<DevPreviewEmptyStates {...baseProps({ status: "error", error })} />);
    expect(screen.getByRole("button", { name: /view terminal/i })).toBeTruthy();
  });

  it("shows the auto-detected command prompt when unconfigured with a primary candidate", () => {
    render(
      <DevPreviewEmptyStates
        {...baseProps({ isUnconfigured: true, currentUrl: "", primaryCandidate: runner() })}
      />
    );
    expect(screen.getByText("Start the dev server")).toBeTruthy();
    expect(screen.getByRole("button", { name: /run npm run dev/i })).toBeTruthy();
  });

  it("shows the manual command form when unconfigured without a detected candidate", () => {
    render(
      <DevPreviewEmptyStates
        {...baseProps({ isUnconfigured: true, currentUrl: "", primaryCandidate: undefined })}
      />
    );
    expect(screen.getByText("Set a dev command")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Dev command" })).toBeTruthy();
  });

  it("shows the auto-detect failure banner with a retry action", () => {
    render(
      <DevPreviewEmptyStates
        {...baseProps({
          isUnconfigured: true,
          currentUrl: "",
          primaryCandidate: runner(),
          autoDetectFailedCommand: "npm run dev",
        })}
      />
    );
    expect(screen.getByText("Couldn't save the command")).toBeTruthy();
  });

  it("renders the restored-stopped placeholder with the saved command", () => {
    render(
      <DevPreviewEmptyStates
        {...baseProps({ status: "restored-stopped", currentUrl: "", devCommand: "npm run dev" })}
      />
    );
    expect(screen.getByText("Restart the dev server")).toBeTruthy();
    expect(screen.getByText("npm run dev")).toBeTruthy();
    expect(screen.getByRole("button", { name: /restart dev server/i })).toBeTruthy();
  });

  it("renders the waiting placeholder while running without a URL", () => {
    render(<DevPreviewEmptyStates {...baseProps({ status: "running", currentUrl: "" })} />);
    expect(screen.getByText(/waiting for the dev server/i)).toBeTruthy();
  });

  it("renders the not-yet-visible placeholder once running with a URL but not yet visible", () => {
    render(<DevPreviewEmptyStates {...baseProps({ hasBeenVisible: false })} />);
    expect(screen.getByText(/preview will load when this panel is first viewed/i)).toBeTruthy();
  });

  it("renders the evicted placeholder once running, visible, and evicted", () => {
    render(<DevPreviewEmptyStates {...baseProps({ isEvicted: true })} />);
    expect(screen.getByText(/preview paused to save memory/i)).toBeTruthy();
  });

  it("renders nothing (null) once running with a URL, visible, and not evicted", () => {
    const { container } = render(<DevPreviewEmptyStates {...baseProps()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("DevPreviewEmptyStates — interaction contract", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const unconfiguredDetected = {
    isUnconfigured: true,
    currentUrl: "",
    status: "stopped" as const,
    primaryCandidate: runner(),
    candidates: [
      runner(),
      runner({ id: "https", name: "dev:https", command: "npm run dev:https" }),
    ],
  };

  const everyState: Array<Partial<React.ComponentProps<typeof DevPreviewEmptyStates>>> = [
    unconfiguredDetected,
    { ...unconfiguredDetected, autoDetectFailedCommand: "npm run dev" },
    { isUnconfigured: true, currentUrl: "", status: "stopped", commandInput: "npm run dev" },
    {
      isUnconfigured: true,
      currentUrl: "",
      status: "stopped",
      commandInput: "npm run dev",
      saveCommandFailed: true,
    },
    { status: "restored-stopped", currentUrl: "", devCommand: "npm run dev" },
    { status: "running", currentUrl: "" },
    { status: "error", error: { type: "port-conflict", message: "Port 3000 is in use" } },
    { status: "error", error: { type: "missing-dependencies", message: "Missing: vite" } },
  ];

  it("offers at most one primary action in every state", () => {
    for (const state of everyState) {
      const { container, unmount } = render(<DevPreviewEmptyStates {...baseProps(state)} />);
      const primaries = container.querySelectorAll('[data-variant="contrast"]');
      expect(primaries.length, JSON.stringify(state)).toBeLessThanOrEqual(1);
      unmount();
    }
  });

  it("never writes a trailing ellipsis as three ASCII dots", () => {
    for (const state of everyState) {
      const { container, unmount } = render(<DevPreviewEmptyStates {...baseProps(state)} />);
      expect(container.textContent ?? "", JSON.stringify(state)).not.toContain("...");
      unmount();
    }
  });

  it("announces the state's title through a live region, not its actions", () => {
    for (const state of everyState) {
      const { unmount } = render(<DevPreviewEmptyStates {...baseProps(state)} />);
      // A failure is an alert; every other state a polite status.
      const status =
        state.status === "error" ? screen.getByRole("alert") : screen.getByRole("status");
      expect((status.textContent ?? "").trim().length).toBeGreaterThan(0);
      expect(within(status).queryAllByRole("button")).toHaveLength(0);
      unmount();
    }
  });

  it("names the command field by a label rather than its placeholder, and submits it as a form", () => {
    const handleSaveCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <DevPreviewEmptyStates
        {...baseProps({
          isUnconfigured: true,
          currentUrl: "",
          status: "stopped",
          commandInput: "npm run dev",
          handleSaveCommand,
        })}
      />
    );
    const field = screen.getByRole("textbox", { name: /.+/ });
    if (!(field instanceof HTMLInputElement)) throw new Error("command field is not an input");
    expect(field.labels?.length ?? 0).toBeGreaterThan(0);
    const form = field.form;
    if (!form) throw new Error("command field sits outside a form, so Enter cannot submit it");
    expect(form.querySelector('button[type="submit"]')).not.toBeNull();
    fireEvent.submit(form);
    expect(handleSaveCommand).toHaveBeenCalledTimes(1);
  });

  it("keeps the busy Run button focusable and marks it busy", () => {
    render(
      <DevPreviewEmptyStates
        {...baseProps({
          isUnconfigured: true,
          currentUrl: "",
          status: "stopped",
          commandInput: "npm run dev",
          isSavingCommand: true,
        })}
      />
    );
    const run = screen.getByRole("button", { name: /^run$/i });
    expect(run.hasAttribute("disabled")).toBe(false);
    expect(run.getAttribute("aria-busy")).toBe("true");
  });

  it("surfaces a failed manual save with a retry that saves again", () => {
    const handleSaveCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <DevPreviewEmptyStates
        {...baseProps({
          isUnconfigured: true,
          currentUrl: "",
          status: "stopped",
          commandInput: "npm run dev",
          saveCommandFailed: true,
          handleSaveCommand,
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(handleSaveCommand).toHaveBeenCalledTimes(1);
  });

  it("replaces Run with the failure's Retry, so a failed save has one commit action", () => {
    const failures = [
      { ...unconfiguredDetected, autoDetectFailedCommand: "npm run dev" },
      {
        isUnconfigured: true,
        currentUrl: "",
        status: "stopped" as const,
        commandInput: "npm run dev",
        saveCommandFailed: true,
      },
    ];
    for (const state of failures) {
      const { unmount } = render(<DevPreviewEmptyStates {...baseProps(state)} />);
      expect(
        screen.queryByRole("button", { name: /^run( npm run dev)?$/i }),
        JSON.stringify(state)
      ).toBeNull();
      expect(screen.getAllByRole("button", { name: /retry/i })).toHaveLength(1);
      unmount();
    }
  });

  it("hands focus from Run to the failure's Retry and back when they swap", () => {
    const props = baseProps(unconfiguredDetected);
    const { rerender } = render(<DevPreviewEmptyStates {...props} />);
    screen.getByRole("button", { name: /^run npm run dev$/i }).focus();

    rerender(<DevPreviewEmptyStates {...props} autoDetectFailedCommand="npm run dev" />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /retry/i }));

    rerender(<DevPreviewEmptyStates {...props} autoDetectFailedCommand={null} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^run npm run dev$/i }));
  });

  it("leaves focus alone on a swap when the slot never held it", () => {
    const props = baseProps(unconfiguredDetected);
    const { rerender } = render(<DevPreviewEmptyStates {...props} />);
    rerender(<DevPreviewEmptyStates {...props} autoDetectFailedCommand="npm run dev" />);
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves the script Run already offers out of the other-scripts menu", () => {
    // Two entries, one command: once Run's own command is set aside there is
    // nothing else to offer, so the menu has no reason to exist.
    const candidates = [runner(), runner({ id: "alias", name: "start", command: "npm run dev" })];
    render(<DevPreviewEmptyStates {...baseProps({ ...unconfiguredDetected, candidates })} />);
    expect(screen.queryByRole("button", { name: /another script/i })).toBeNull();
  });

  it("offers the recommendation back in the menu after an alternate script fails", async () => {
    render(
      <DevPreviewEmptyStates
        {...baseProps({ ...unconfiguredDetected, autoDetectFailedCommand: "npm run dev:https" })}
      />
    );
    const trigger = screen.getByRole("button", { name: /another script/i });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = await screen.findAllByRole("menuitem");
    const offered = items.map((item) => item.textContent);
    expect(offered).toContain("npm run dev");
    expect(offered).not.toContain("npm run dev:https");
  });

  it("shows the command that failed, not the first candidate, beside the retry", () => {
    render(
      <DevPreviewEmptyStates
        {...baseProps({ ...unconfiguredDetected, autoDetectFailedCommand: "npm run dev:https" })}
      />
    );
    expect(screen.getByText("npm run dev:https")).toBeTruthy();
    expect(screen.queryByText("npm run dev")).toBeNull();
  });

  it("exposes the other-scripts picker as a menu button", () => {
    render(<DevPreviewEmptyStates {...baseProps(unconfiguredDetected)} />);
    const trigger = screen.getByRole("button", { name: /another script/i });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("offers to start a stopped server once the start-up window has passed", () => {
    vi.useFakeTimers();
    const handleRetry = vi.fn();
    render(
      <DevPreviewEmptyStates
        {...baseProps({
          status: "stopped",
          currentUrl: "",
          devCommand: "npm run dev",
          handleRetry,
        })}
      />
    );
    expect(screen.queryByRole("button", { name: /start dev server/i })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.click(screen.getByRole("button", { name: /start dev server/i }));
    expect(handleRetry).toHaveBeenCalledTimes(1);
  });
});

// DevPreviewPane.tsx gates rendering this component vs. the live webview with a
// `showEmptyState` boolean that must exactly mirror the branch order below. This
// duplicates that formula (see DevPreviewPane.tsx) so a regression on either side
// fails a test instead of silently mounting both the webview and a placeholder,
// or neither.
function computeShowEmptyState(props: {
  isRestarting: boolean;
  status: string;
  isProxyUrlPending: boolean;
  error: unknown;
  currentUrl: string;
  hasBeenVisible: boolean;
  isEvicted: boolean;
}): boolean {
  return (
    props.isRestarting ||
    props.status === "starting" ||
    props.status === "installing" ||
    props.isProxyUrlPending ||
    (props.status === "error" && !!props.error) ||
    !props.currentUrl ||
    props.status !== "running" ||
    !props.hasBeenVisible ||
    props.isEvicted
  );
}

describe("DevPreviewEmptyStates — parent gate parity", () => {
  const scenarios: Array<Partial<React.ComponentProps<typeof DevPreviewEmptyStates>>> = [
    {
      status: "running",
      currentUrl: "http://localhost:3000",
      hasBeenVisible: true,
      isEvicted: false,
    },
    { isRestarting: true },
    { status: "starting" },
    { status: "installing" },
    { isProxyUrlPending: true },
    { status: "error", error: { type: "unknown", message: "boom" } as DevServerError },
    { currentUrl: "" },
    { status: "stopped" },
    { status: "restored-stopped" },
    { hasBeenVisible: false },
    { isEvicted: true },
  ];

  for (const scenario of scenarios) {
    it(`agrees with DevPreviewPane's showEmptyState for ${JSON.stringify(scenario)}`, () => {
      const props = baseProps(scenario);
      const expectedEmpty = computeShowEmptyState(props);
      const { container } = render(<DevPreviewEmptyStates {...props} />);
      const rendersNull = container.firstChild === null;
      expect(rendersNull).toBe(!expectedEmpty);
    });
  }
});
