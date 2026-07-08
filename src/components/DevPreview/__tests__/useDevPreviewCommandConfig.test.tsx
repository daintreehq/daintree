/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act, render, screen } from "@testing-library/react";
import type { RunCommand } from "@shared/types";

const saveSettingsMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({ saveSettings: saveSettingsMock }),
}));

const getSettingsMock = vi.fn();
const detectRunnersMock = vi.fn();
vi.mock("@/clients", () => ({
  projectClient: {
    getSettings: (...args: unknown[]) => getSettingsMock(...args),
    detectRunners: (...args: unknown[]) => detectRunnersMock(...args),
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button onClick={onSelect} role="menuitem">
      {children}
    </button>
  ),
}));

import { useDevPreviewCommandConfig } from "../useDevPreviewCommandConfig";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";

function runner(overrides: Partial<RunCommand> = {}): RunCommand {
  return {
    id: "dev",
    name: "dev",
    command: "npm run dev",
    ...overrides,
  } as RunCommand;
}

function baseParams(overrides: Partial<Parameters<typeof useDevPreviewCommandConfig>[0]> = {}) {
  return {
    currentProjectId: "proj-1",
    devCommand: "",
    isUnconfigured: true,
    projectSettings: { turbopackEnabled: true } as never,
    stop: vi.fn(),
    isMountedRef: { current: true },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  saveSettingsMock.mockResolvedValue(undefined);
  useProjectSettingsStore.setState({ allDetectedRunners: [], settings: null, isLoading: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDevPreviewCommandConfig", () => {
  it("derives candidates from allDetectedRunners and picks the first as primary", () => {
    useProjectSettingsStore.setState({ allDetectedRunners: [runner()] });
    const { result } = renderHook(() => useDevPreviewCommandConfig(baseParams()));
    expect(result.current.candidates).toHaveLength(1);
    expect(result.current.primaryCandidate?.command).toBe("npm run dev");
  });

  it("returns null headerContent while unconfigured, regardless of candidates", () => {
    useProjectSettingsStore.setState({ allDetectedRunners: [runner()] });
    const { result } = renderHook(() =>
      useDevPreviewCommandConfig(baseParams({ isUnconfigured: true }))
    );
    expect(result.current.headerContent).toBeNull();
  });

  it("returns null headerContent when configured but no candidates were detected", () => {
    useProjectSettingsStore.setState({ allDetectedRunners: [] });
    const { result } = renderHook(() =>
      useDevPreviewCommandConfig(baseParams({ isUnconfigured: false, devCommand: "npm run dev" }))
    );
    expect(result.current.headerContent).toBeNull();
  });

  it("renders headerContent once configured with at least one candidate", () => {
    useProjectSettingsStore.setState({ allDetectedRunners: [runner()] });
    const { result } = renderHook(() =>
      useDevPreviewCommandConfig(baseParams({ isUnconfigured: false, devCommand: "npm run dev" }))
    );
    expect(result.current.headerContent).not.toBeNull();
  });

  it("handleAutoDetect saves the explicit candidate command and returns true on success", async () => {
    getSettingsMock.mockResolvedValue({ turbopackEnabled: true });
    const { result } = renderHook(() => useDevPreviewCommandConfig(baseParams()));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.handleAutoDetect("npm run dev");
    });

    expect(outcome).toBe(true);
    expect(saveSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        devServerCommand: "npm run dev",
        devServerAutoDetected: true,
        devServerDismissed: false,
      })
    );
    expect(detectRunnersMock).not.toHaveBeenCalled();
  });

  it("handleAutoDetect falls back to freshly detected runners when no candidate is given", async () => {
    getSettingsMock.mockResolvedValue({ turbopackEnabled: true });
    detectRunnersMock.mockResolvedValue([runner({ command: "npm run start" })]);
    const { result } = renderHook(() => useDevPreviewCommandConfig(baseParams()));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.handleAutoDetect();
    });

    expect(outcome).toBe(true);
    expect(saveSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ devServerCommand: "npm run start" })
    );
  });

  it("handleAutoDetect sets autoDetectFailedCommand to empty string when re-detection finds nothing", async () => {
    getSettingsMock.mockResolvedValue({ turbopackEnabled: true });
    detectRunnersMock.mockResolvedValue([]);
    const { result } = renderHook(() => useDevPreviewCommandConfig(baseParams()));

    await act(async () => {
      await result.current.handleAutoDetect();
    });

    await waitFor(() => expect(result.current.autoDetectFailedCommand).toBe(""));
    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it("handleAutoDetect is a no-op without a currentProjectId", async () => {
    const { result } = renderHook(() =>
      useDevPreviewCommandConfig(baseParams({ currentProjectId: undefined }))
    );

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.handleAutoDetect("npm run dev");
    });

    expect(outcome).toBe(false);
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("clears a stale autoDetectFailedCommand once devCommand becomes non-empty", () => {
    const { result, rerender } = renderHook((props) => useDevPreviewCommandConfig(props), {
      initialProps: baseParams({ devCommand: "" }),
    });
    act(() => {
      result.current.handleSaveCommand();
    });
    rerender(baseParams({ devCommand: "npm run dev" }));
    expect(result.current.autoDetectFailedCommand).toBeNull();
  });

  it("commandInputError flags a multi-line command string", () => {
    const { result } = renderHook(() => useDevPreviewCommandConfig(baseParams()));
    act(() => {
      result.current.setCommandInput("npm run dev\nnpm run other");
    });
    expect(result.current.commandInputError).not.toBeNull();
  });

  it("handleSaveCommand is a no-op for a blank or invalid command", async () => {
    const { result } = renderHook(() => useDevPreviewCommandConfig(baseParams()));
    await act(async () => {
      await result.current.handleSaveCommand();
    });
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("handleSaveCommand persists a valid trimmed command", async () => {
    getSettingsMock.mockResolvedValue({ turbopackEnabled: true });
    const { result } = renderHook(() => useDevPreviewCommandConfig(baseParams()));
    act(() => {
      result.current.setCommandInput("  npm run dev  ");
    });
    await act(async () => {
      await result.current.handleSaveCommand();
    });
    expect(saveSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        devServerCommand: "npm run dev",
        devServerAutoDetected: false,
      })
    );
  });
});

describe("useDevPreviewCommandConfig — header script picker", () => {
  it("picking the already-active script is a no-op (does not save or stop)", async () => {
    useProjectSettingsStore.setState({
      allDetectedRunners: [
        runner(),
        runner({ id: "start", name: "start", command: "npm run start" }),
      ],
    });
    const stop = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewCommandConfig(
        baseParams({ isUnconfigured: false, devCommand: "npm run dev", stop })
      )
    );
    render(<>{result.current.headerContent}</>);

    await act(async () => {
      screen.getByRole("menuitem", { name: /dev.*npm run dev/i }).click();
      await Promise.resolve();
    });

    expect(saveSettingsMock).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("picking a different script saves it and stops the running server", async () => {
    getSettingsMock.mockResolvedValue({ turbopackEnabled: true });
    useProjectSettingsStore.setState({
      allDetectedRunners: [
        runner(),
        runner({ id: "start", name: "start", command: "npm run start" }),
      ],
    });
    const stop = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewCommandConfig(
        baseParams({ isUnconfigured: false, devCommand: "npm run dev", stop })
      )
    );
    render(<>{result.current.headerContent}</>);

    await act(async () => {
      screen.getByRole("menuitem", { name: /start.*npm run start/i }).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ devServerCommand: "npm run start" })
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not stop the server when saving the newly picked script fails", async () => {
    getSettingsMock.mockResolvedValue(null);
    useProjectSettingsStore.setState({
      allDetectedRunners: [
        runner(),
        runner({ id: "start", name: "start", command: "npm run start" }),
      ],
    });
    const stop = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewCommandConfig(
        baseParams({ isUnconfigured: false, devCommand: "npm run dev", stop })
      )
    );
    render(<>{result.current.headerContent}</>);

    await act(async () => {
      screen.getByRole("menuitem", { name: /start.*npm run start/i }).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveSettingsMock).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});
