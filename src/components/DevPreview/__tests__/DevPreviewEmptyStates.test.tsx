// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    isSettingsLoading: false,
    handleAutoDetect: vi.fn().mockResolvedValue(true),
    autoDetectFailedCommand: null,
    candidates: [],
    pickerOpen: false,
    setPickerOpen: vi.fn(),
    handlePickCandidate: vi.fn(),
    handleOpenSettings: vi.fn(),
    commandInput: "",
    setCommandInput: vi.fn(),
    handleSaveCommand: vi.fn().mockResolvedValue(undefined),
    commandInputError: null,
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
    expect(screen.getByRole("button", { name: /run `npm run dev`/i })).toBeTruthy();
  });

  it("shows the manual command form when unconfigured without a detected candidate", () => {
    render(
      <DevPreviewEmptyStates
        {...baseProps({ isUnconfigured: true, currentUrl: "", primaryCandidate: undefined })}
      />
    );
    expect(screen.getByText("Set a dev command")).toBeTruthy();
    expect(screen.getByPlaceholderText("npm run dev")).toBeTruthy();
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
    expect(screen.getByText("Couldn't start preview")).toBeTruthy();
  });

  it("renders the restored-stopped placeholder with the saved command", () => {
    render(
      <DevPreviewEmptyStates
        {...baseProps({ status: "restored-stopped", currentUrl: "", devCommand: "npm run dev" })}
      />
    );
    expect(screen.getByText("Dev server was running")).toBeTruthy();
    expect(screen.getByText("npm run dev")).toBeTruthy();
    expect(screen.getByRole("button", { name: /restart dev server/i })).toBeTruthy();
  });

  it("renders the generic waiting placeholder for any other non-running status", () => {
    render(<DevPreviewEmptyStates {...baseProps({ status: "stopped", currentUrl: "" })} />);
    expect(screen.getByText("Waiting for dev server")).toBeTruthy();
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
