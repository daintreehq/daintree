/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act, render, screen } from "@testing-library/react";
import type { RunCommand } from "@shared/types";

const saveSettingsMock = vi.fn().mockResolvedValue(undefined);
const refreshSettingsMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({ saveSettings: saveSettingsMock, refresh: refreshSettingsMock }),
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
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="menu-label">{children}</div>
  ),
  DropdownMenuSeparator: () => null,
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
    hasOwnCommand: false,
    setOwnCommand: vi.fn(),
    isUnconfigured: true,
    projectSettings: { turbopackEnabled: true } as never,
    isMountedRef: { current: true },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  saveSettingsMock.mockResolvedValue(undefined);
  refreshSettingsMock.mockResolvedValue(undefined);
  useProjectSettingsStore.setState({ allDetectedRunners: [], settings: null, isLoading: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDevPreviewCommandConfig", () => {
  it("re-detects project scripts once when the preview opens", () => {
    const { rerender } = renderHook((props) => useDevPreviewCommandConfig(props), {
      initialProps: baseParams(),
    });
    rerender(baseParams({ devCommand: "npm run dev" }));

    expect(refreshSettingsMock).toHaveBeenCalledTimes(1);
  });

  it("re-detects again when the preview moves to another project", () => {
    const { rerender } = renderHook((props) => useDevPreviewCommandConfig(props), {
      initialProps: baseParams(),
    });
    rerender(baseParams({ currentProjectId: "proj-2" }));

    expect(refreshSettingsMock).toHaveBeenCalledTimes(2);
  });

  it("does not re-detect without a project", () => {
    renderHook(() => useDevPreviewCommandConfig(baseParams({ currentProjectId: undefined })));

    expect(refreshSettingsMock).not.toHaveBeenCalled();
  });

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
  const twoScripts = () =>
    useProjectSettingsStore.setState({
      allDetectedRunners: [
        runner(),
        runner({ id: "start", name: "start", command: "npm run start" }),
      ],
    });

  async function pick(name: RegExp) {
    await act(async () => {
      screen.getByRole("menuitem", { name }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("picking the already-active script is a no-op", async () => {
    twoScripts();
    const setOwnCommand = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewCommandConfig(
        baseParams({ isUnconfigured: false, devCommand: "npm run dev", setOwnCommand })
      )
    );
    render(<>{result.current.headerContent}</>);

    await pick(/dev.*npm run dev/i);

    expect(saveSettingsMock).not.toHaveBeenCalled();
    expect(setOwnCommand).not.toHaveBeenCalled();
  });

  it("gives a preview with its own command the picked script, leaving the project default alone", async () => {
    getSettingsMock.mockResolvedValue({ turbopackEnabled: true, devServerCommand: "npm run dev" });
    twoScripts();
    const setOwnCommand = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewCommandConfig(
        baseParams({
          isUnconfigured: false,
          devCommand: "npm run dev",
          hasOwnCommand: true,
          setOwnCommand,
        })
      )
    );
    render(<>{result.current.headerContent}</>);

    await pick(/start.*npm run start/i);

    expect(setOwnCommand).toHaveBeenCalledWith("npm run start");
    expect(getSettingsMock).not.toHaveBeenCalled();
    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it("moves the project default when the preview inherits it", async () => {
    getSettingsMock.mockResolvedValue({ turbopackEnabled: true, devServerCommand: "npm run dev" });
    twoScripts();
    const setOwnCommand = vi.fn();
    const { result } = renderHook(() =>
      useDevPreviewCommandConfig(
        baseParams({ isUnconfigured: false, devCommand: "npm run dev", setOwnCommand })
      )
    );
    render(<>{result.current.headerContent}</>);

    await pick(/start.*npm run start/i);

    expect(saveSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ devServerCommand: "npm run start" })
    );
    expect(setOwnCommand).not.toHaveBeenCalled();
  });

  it("says the pick moves the project default only on an inheriting preview", () => {
    twoScripts();
    const inheriting = renderHook(() =>
      useDevPreviewCommandConfig(baseParams({ isUnconfigured: false, devCommand: "npm run dev" }))
    );
    const own = renderHook(() =>
      useDevPreviewCommandConfig(
        baseParams({ isUnconfigured: false, devCommand: "npm run dev", hasOwnCommand: true })
      )
    );

    const inheritingMenu = render(<>{inheriting.result.current.headerContent}</>);
    expect(inheritingMenu.getByTestId("menu-label").textContent).toMatch(/project default/i);
    expect(inheritingMenu.container.textContent).toMatch(/other previews/i);
    inheritingMenu.unmount();

    const ownMenu = render(<>{own.result.current.headerContent}</>);
    expect(ownMenu.getByTestId("menu-label").textContent).toMatch(/this preview/i);
    expect(ownMenu.container.textContent).not.toMatch(/project default|other previews/i);
  });
});
