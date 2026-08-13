// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";
import type { PrerequisiteCheckResult, SystemHealthCheckResult } from "@shared/types";
import type { AgentInstallProgressEvent } from "@shared/types/ipc/system";

const checkCommandMock = vi.hoisted(() => vi.fn());
const healthCheckMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  systemClient: { checkCommand: checkCommandMock, healthCheck: healthCheckMock },
}));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock.mockResolvedValue({ ok: true, result: undefined }) },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

// The banner reads the current OS to choose an install block.
vi.mock("@/lib/platform", () => ({
  isMac: () => true,
  isWindows: () => false,
  isLinux: () => false,
}));

import { MissingPrerequisiteBanner } from "../MissingPrerequisiteBanner";
import { useMissingPrerequisiteStore } from "@/store/missingPrerequisiteStore";

const MACOS_BLOCKS = {
  macos: [
    { label: "Homebrew", commands: ["brew install git"] },
    {
      label: "Xcode Command Line Tools",
      commands: ["xcode-select --install"],
      opensExternalInstaller: true,
    },
  ],
};

function missingGit(overrides: Partial<PrerequisiteCheckResult> = {}): PrerequisiteCheckResult {
  return {
    tool: "git",
    label: "Git",
    available: false,
    unavailableReason: "not-found",
    version: null,
    severity: "fatal",
    meetsMinVersion: false,
    installBlocks: MACOS_BLOCKS,
    installUrl: "https://git-scm.com/downloads",
    ...overrides,
  };
}

function health(prerequisites: PrerequisiteCheckResult[]): SystemHealthCheckResult {
  return {
    prerequisites,
    allRequired: prerequisites.every((p) => p.available && p.meetsMinVersion),
  };
}

const HEALTHY_GIT: PrerequisiteCheckResult = {
  tool: "git",
  label: "Git",
  available: true,
  version: "2.43.0",
  severity: "fatal",
  meetsMinVersion: true,
};

let progressListeners: ((event: AgentInstallProgressEvent) => void)[] = [];
let installAgentMock: ReturnType<typeof vi.fn>;
let removeListener: ReturnType<typeof vi.fn>;

function emitProgress(event: AgentInstallProgressEvent) {
  act(() => {
    for (const listener of progressListeners) listener(event);
  });
}

/** Clicks and lets the handler's first async hop settle. */
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

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
  if (!("randomUUID" in crypto)) {
    Object.defineProperty(crypto, "randomUUID", { value: () => "test-uuid", writable: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  progressListeners = [];
  removeListener = vi.fn();
  installAgentMock = vi.fn();
  Object.defineProperty(window, "electron", {
    writable: true,
    configurable: true,
    value: {
      system: {
        installAgent: installAgentMock,
        onAgentInstallProgress: (cb: (event: AgentInstallProgressEvent) => void) => {
          progressListeners.push(cb);
          return removeListener;
        },
      },
    },
  });
  useMissingPrerequisiteStore.setState({
    missing: [],
    dismissed: false,
    inlineSurfaceCount: 0,
    install: null,
  });
  checkCommandMock.mockResolvedValue(true);
  healthCheckMock.mockResolvedValue(health([HEALTHY_GIT]));
});

afterEach(() => {
  cleanup();
  if (vi.isFakeTimers()) vi.useRealTimers();
});

describe("MissingPrerequisiteBanner", () => {
  describe("package manager gating", () => {
    it("offers the install once the package manager is present", async () => {
      useMissingPrerequisiteStore.setState({ missing: [missingGit()] });

      render(<MissingPrerequisiteBanner />);

      expect(await screen.findByRole("button", { name: "Install Git" })).toBeTruthy();
      expect(checkCommandMock).toHaveBeenCalledWith("brew");
    });

    it("never offers the install when the package manager is absent", async () => {
      checkCommandMock.mockResolvedValue(false);
      useMissingPrerequisiteStore.setState({ missing: [missingGit({ installUrl: undefined })] });

      render(<MissingPrerequisiteBanner />);

      // Re-check is also the *initial* render, so settle the probe first —
      // otherwise this passes before the mocked answer has been seen at all.
      await waitFor(() => expect(checkCommandMock).toHaveBeenCalledWith("brew"));
      await act(async () => {});

      expect(screen.getByRole("button", { name: "Re-check" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Install Git" })).toBeNull();
    });

    it("never offers the install when the package manager probe rejects", async () => {
      checkCommandMock.mockRejectedValue(new Error("probe failed"));
      useMissingPrerequisiteStore.setState({ missing: [missingGit({ installUrl: undefined })] });

      render(<MissingPrerequisiteBanner />);

      await waitFor(() => expect(checkCommandMock).toHaveBeenCalledWith("brew"));
      await act(async () => {});

      expect(screen.getByRole("button", { name: "Re-check" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Install Git" })).toBeNull();
    });

    it("points at the install guide when the package manager is absent", async () => {
      checkCommandMock.mockResolvedValue(false);
      useMissingPrerequisiteStore.setState({ missing: [missingGit()] });

      render(<MissingPrerequisiteBanner />);

      // The command on screen needs a package manager they don't have, so
      // Re-check on its own would be no help.
      expect(await screen.findByRole("button", { name: "View install guide" })).toBeTruthy();
    });

    it("still shows the command when the block is not safe to run for us", async () => {
      useMissingPrerequisiteStore.setState({
        missing: [
          missingGit({ installBlocks: { macos: [{ commands: ["sudo apt-get install git"] }] } }),
        ],
      });

      render(<MissingPrerequisiteBanner />);

      // Linux-style sudo blocks are copy-paste only, but the user still needs
      // to see what to paste.
      expect(await screen.findByText("sudo apt-get install git")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Install Git" })).toBeNull();
    });

    it("offers the install guide when there is no block at all", async () => {
      useMissingPrerequisiteStore.setState({
        missing: [missingGit({ installBlocks: undefined })],
      });

      render(<MissingPrerequisiteBanner />);

      const button = await screen.findByRole("button", { name: "View install guide" });
      await click(button);

      expect(dispatchMock).toHaveBeenCalledWith(
        "system.openExternal",
        { url: "https://git-scm.com/downloads" },
        expect.anything()
      );
    });
  });

  describe("install flow", () => {
    it("streams the latest output line as the status", async () => {
      installAgentMock.mockReturnValue(new Promise(() => {}));
      useMissingPrerequisiteStore.setState({ missing: [missingGit()] });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Install Git" }));

      const jobId = useMissingPrerequisiteStore.getState().install?.jobId ?? "";
      emitProgress({ jobId, chunk: "Fetching git\nPouring git\n", stream: "stdout" });

      expect(await screen.findByText("Pouring git")).toBeTruthy();
    });

    it("ignores progress from a job that is not the live one", async () => {
      installAgentMock.mockReturnValue(new Promise(() => {}));
      useMissingPrerequisiteStore.setState({ missing: [missingGit()] });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Install Git" }));
      emitProgress({ jobId: "some-other-job", chunk: "stale output", stream: "stdout" });

      expect(screen.queryByText("stale output")).toBeNull();
    });

    it("swaps to a reassurance once the install outlasts the threshold", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      installAgentMock.mockReturnValue(new Promise(() => {}));
      useMissingPrerequisiteStore.setState({ missing: [missingGit()] });
      render(<MissingPrerequisiteBanner />);

      const button = await screen.findByRole("button", { name: "Install Git" });
      await click(button);
      await waitFor(() =>
        expect(useMissingPrerequisiteStore.getState().install?.status).toBe("running")
      );

      expect(screen.queryByText("Still working…")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(screen.getByText("Still working…")).toBeTruthy();
    });

    it("confirms success against a fresh probe, not the exit code", async () => {
      installAgentMock.mockResolvedValue({ success: true, exitCode: 0 });
      useMissingPrerequisiteStore.setState({ missing: [missingGit()] });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Install Git" }));

      await waitFor(() => expect(notifyMock).toHaveBeenCalled());
      expect(healthCheckMock).toHaveBeenCalledWith({ fatalOnly: true, force: true });
      expect(notifyMock.mock.calls[0]?.[0].title).toBe("Git installed");
      expect(useMissingPrerequisiteStore.getState().missing).toEqual([]);
    });

    it("reports failure when the probe still cannot find the tool", async () => {
      installAgentMock.mockResolvedValue({ success: true, exitCode: 0 });
      healthCheckMock.mockResolvedValue(health([missingGit()]));
      useMissingPrerequisiteStore.setState({ missing: [missingGit()] });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Install Git" }));

      await waitFor(() =>
        expect(useMissingPrerequisiteStore.getState().install?.status).toBe("error")
      );
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("surfaces a failed install as an error with streamed stderr", async () => {
      let resolveInstall: (value: { success: boolean; exitCode: number | null }) => void = () => {};
      installAgentMock.mockReturnValue(
        new Promise<{ success: boolean; exitCode: number | null }>((resolve) => {
          resolveInstall = resolve;
        })
      );
      useMissingPrerequisiteStore.setState({ missing: [missingGit()] });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Install Git" }));
      const jobId = useMissingPrerequisiteStore.getState().install?.jobId ?? "";
      emitProgress({ jobId, chunk: "Error: no such formula", stream: "stderr" });
      await act(async () => {
        resolveInstall({ success: false, exitCode: 1 });
        await Promise.resolve();
      });

      expect(await screen.findByText("Error: no such formula")).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    });

    it("titles a failed install with the display name, not the tool id", async () => {
      installAgentMock.mockResolvedValue({ success: false, exitCode: 1 });
      const spec = missingGit({ tool: "some-tool", label: "Some Tool" });
      useMissingPrerequisiteStore.setState({ missing: [spec] });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: `Install ${spec.label}` }));

      expect(await screen.findByText(`Couldn't install ${spec.label}`)).toBeTruthy();
      expect(useMissingPrerequisiteStore.getState().install?.tool).toBe(spec.tool);
      expect(screen.queryByText(`Couldn't install ${spec.tool}`)).toBeNull();
    });

    it("removes the progress listener when the job settles", async () => {
      installAgentMock.mockResolvedValue({ success: true, exitCode: 0 });
      useMissingPrerequisiteStore.setState({ missing: [missingGit()] });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Install Git" }));

      await waitFor(() => expect(removeListener).toHaveBeenCalled());
    });

    it("does not start a second install while one is running", async () => {
      installAgentMock.mockReturnValue(new Promise(() => {}));
      useMissingPrerequisiteStore.setState({ missing: [missingGit()] });
      const { unmount } = render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Install Git" }));
      await waitFor(() =>
        expect(useMissingPrerequisiteStore.getState().install?.status).toBe("running")
      );

      // A higher-priority global banner takes the slot, then releases it.
      unmount();
      render(<MissingPrerequisiteBanner />);

      const button = await screen.findByRole("button", { name: "Install Git" });
      await click(button);

      expect(installAgentMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("macOS Command Line Tools", () => {
    it("offers the installer hand-off rather than an auto-install", async () => {
      useMissingPrerequisiteStore.setState({
        missing: [missingGit({ unavailableReason: "macos-command-line-tools-missing" })],
      });

      render(<MissingPrerequisiteBanner />);

      expect(await screen.findByRole("button", { name: "Open installer" })).toBeTruthy();
      expect(checkCommandMock).toHaveBeenCalledWith("xcode-select");
    });

    it("asks the user to finish the installer instead of claiming success", async () => {
      installAgentMock.mockResolvedValue({ success: true, exitCode: 0 });
      useMissingPrerequisiteStore.setState({
        missing: [missingGit({ unavailableReason: "macos-command-line-tools-missing" })],
      });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Open installer" }));

      // Exit 0 only means the GUI installer opened.
      await waitFor(() =>
        expect(useMissingPrerequisiteStore.getState().install?.status).toBe("handed-off")
      );
      expect(notifyMock).not.toHaveBeenCalled();
      expect(healthCheckMock).not.toHaveBeenCalled();
      expect(screen.getByText("Finish the macOS installer, then re-check")).toBeTruthy();
    });

    it("selects the Command Line Tools method, not Homebrew", async () => {
      installAgentMock.mockResolvedValue({ success: true, exitCode: 0 });
      useMissingPrerequisiteStore.setState({
        missing: [missingGit({ unavailableReason: "macos-command-line-tools-missing" })],
      });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Open installer" }));

      await waitFor(() => expect(installAgentMock).toHaveBeenCalled());
      expect(installAgentMock.mock.calls[0]?.[0]).toMatchObject({
        prerequisiteTool: "git",
        methodIndex: 1,
      });
    });
  });

  describe("re-check", () => {
    it("clears the banner when the tool is now present", async () => {
      checkCommandMock.mockResolvedValue(false);
      useMissingPrerequisiteStore.setState({ missing: [missingGit({ installUrl: undefined })] });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Re-check" }));

      await waitFor(() => expect(useMissingPrerequisiteStore.getState().missing).toEqual([]));
      expect(healthCheckMock).toHaveBeenCalledWith({ fatalOnly: true, force: true });
    });

    it("tells the user when the re-check itself fails", async () => {
      checkCommandMock.mockResolvedValue(false);
      healthCheckMock.mockRejectedValue(new Error("probe exploded"));
      useMissingPrerequisiteStore.setState({ missing: [missingGit({ installUrl: undefined })] });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Re-check" }));

      expect(await screen.findByText(/probe exploded/)).toBeTruthy();
    });

    it("does not clear an install that started while it was in flight", async () => {
      // The re-check begins with no job running, so its entry guard passes;
      // an install starts before the probe resolves. Writing `null` on the way
      // out would strand that job with no state and no progress.
      let resolveHealth: (value: SystemHealthCheckResult) => void = () => {};
      healthCheckMock.mockReturnValue(
        new Promise<SystemHealthCheckResult>((resolve) => {
          resolveHealth = resolve;
        })
      );
      checkCommandMock.mockResolvedValue(false);
      useMissingPrerequisiteStore.setState({ missing: [missingGit({ installUrl: undefined })] });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Re-check" }));

      act(() => {
        useMissingPrerequisiteStore.getState().setInstall({
          jobId: "live",
          tool: "git",
          status: "running",
          statusLine: "",
          error: null,
        });
      });
      await act(async () => {
        resolveHealth(health([HEALTHY_GIT]));
        await Promise.resolve();
      });

      expect(useMissingPrerequisiteStore.getState().install?.jobId).toBe("live");
      expect(useMissingPrerequisiteStore.getState().install?.status).toBe("running");
    });

    it("renders a live job as installing even straight after a remount", async () => {
      // The remount restarts the package-manager probe, which must not flash a
      // Re-check button over a running install.
      checkCommandMock.mockReturnValue(new Promise(() => {}));
      useMissingPrerequisiteStore.setState({
        missing: [missingGit()],
        install: { jobId: "live", tool: "git", status: "running", statusLine: "", error: null },
      });

      render(<MissingPrerequisiteBanner />);

      const button = screen.getByRole("button", { name: "Install Git" });
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(screen.queryByRole("button", { name: "Re-check" })).toBeNull();
    });
  });

  describe("copy", () => {
    it("titles an outdated tool as out of date rather than missing", () => {
      useMissingPrerequisiteStore.setState({
        missing: [missingGit({ available: true, version: "1.0.0", unavailableReason: undefined })],
      });

      render(<MissingPrerequisiteBanner />);

      expect(screen.getByText("Git is out of date")).toBeTruthy();
    });

    it("names the still-outstanding tools after a partial fix", async () => {
      const node = missingGit({ tool: "node", label: "Node.js", installBlocks: undefined });
      installAgentMock.mockResolvedValue({ success: true, exitCode: 0 });
      healthCheckMock.mockResolvedValue(health([HEALTHY_GIT, node]));
      useMissingPrerequisiteStore.setState({ missing: [missingGit(), node] });
      render(<MissingPrerequisiteBanner />);

      await click(await screen.findByRole("button", { name: "Install Git" }));

      await waitFor(() => expect(notifyMock).toHaveBeenCalled());
      // It must not claim everything works while Node is still missing, and it
      // must not list the tool it just installed as outstanding.
      const message = String(notifyMock.mock.calls[0]?.[0].message);
      const outstanding = useMissingPrerequisiteStore.getState().missing.map((p) => p.label);
      expect(outstanding).toEqual(["Node.js"]);
      for (const label of outstanding) expect(message).toContain(label);
      expect(message).not.toContain("Git");
    });
  });
});
