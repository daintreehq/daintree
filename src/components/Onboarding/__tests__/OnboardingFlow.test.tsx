// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OnboardingState } from "@shared/types";

const trackMock = vi.fn(() => Promise.resolve());

const defaultOnboardingState: OnboardingState = {
  schemaVersion: 1,
  completed: false,
  currentStep: null,
  agentSetupIds: [],
  migratedFromLocalStorage: true,
  firstRunToastSeen: false,
  newsletterPromptSeen: false,
  waitingNudgeSeen: false,
  checklist: {
    dismissed: false,
    celebrationShown: false,
    items: {
      openedProject: false,
      launchedAgent: false,
      createdWorktree: false,
      subscribedNewsletter: false,
    },
  },
};

const onboardingMock = {
  get: vi.fn(() => Promise.resolve({ ...defaultOnboardingState })),
  setStep: vi.fn(() => Promise.resolve()),
  complete: vi.fn(() => Promise.resolve()),
  migrate: vi.fn(() => Promise.resolve({ ...defaultOnboardingState })),
  markToastSeen: vi.fn(() => Promise.resolve()),
  markNewsletterSeen: vi.fn(() => Promise.resolve()),
};

const telemetryMock = {
  get: vi.fn(() => Promise.resolve({ enabled: false, hasSeenPrompt: false })),
  setEnabled: vi.fn(() => Promise.resolve()),
  markPromptShown: vi.fn(() => Promise.resolve()),
  track: trackMock,
};

const privacyMock = {
  setTelemetryLevel: vi.fn(() => Promise.resolve()),
};

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: {
    onboarding: onboardingMock,
    telemetry: telemetryMock,
    privacy: privacyMock,
  },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

const { isCanopyEnvEnabledMock } = vi.hoisted(() => ({
  isCanopyEnvEnabledMock: vi.fn((_key: string): boolean => false),
}));
vi.mock("@/utils/env", () => ({
  isDaintreeEnvEnabled: (key: string) => isCanopyEnvEnabledMock(key),
}));

vi.mock("@/components/Setup/AgentSetupWizard", () => ({
  AgentSetupWizard: vi.fn((props: { onClose: () => void; isFirstRun?: boolean }) => {
    return (
      <div data-testid="agent-setup-wizard" data-first-run={props.isFirstRun ? "true" : "false"}>
        <button data-testid="close-wizard" onClick={props.onClose}>
          Close
        </button>
      </div>
    );
  }),
}));

import { OnboardingFlow } from "../OnboardingFlow";

describe("OnboardingFlow first-run", () => {
  const defaultProps = {
    availability: {} as import("@shared/types").CliAvailability,
    onRefreshSettings: vi.fn(() => Promise.resolve()),
    hasAnySelectedAgent: true as boolean | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState });
  });

  it("renders AgentSetupWizard with isFirstRun=true on first run", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      const wizard = getByTestId("agent-setup-wizard");
      expect(wizard).toBeTruthy();
      expect(wizard.getAttribute("data-first-run")).toBe("true");
    });
  });

  it("completes onboarding when wizard closes", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });

    await act(async () => {
      getByTestId("close-wizard").click();
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith(
        "onboarding_completed",
        expect.objectContaining({ totalSteps: 1 })
      );
    });
  });

  it("calls onRefreshSettings when wizard closes", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });

    await act(async () => {
      getByTestId("close-wizard").click();
    });

    await vi.waitFor(() => {
      expect(defaultProps.onRefreshSettings).toHaveBeenCalled();
    });
  });
});

describe("OnboardingFlow telemetry tracking", () => {
  const defaultProps = {
    availability: {} as import("@shared/types").CliAvailability,
    onRefreshSettings: vi.fn(() => Promise.resolve()),
    hasAnySelectedAgent: true as boolean | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState });
  });

  it("emits onboarding_step_viewed when agentSetup step renders", async () => {
    await act(async () => {
      render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith("onboarding_step_viewed", {
        step: "agentSetup",
        stepIndex: 0,
      });
    });
  });

  it("emits onboarding_abandoned on unmount when flow is incomplete", async () => {
    const { unmount } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith("onboarding_step_viewed", expect.any(Object));
    });

    trackMock.mockClear();
    unmount();

    expect(trackMock).toHaveBeenCalledWith("onboarding_abandoned", {
      lastStep: "agentSetup",
      lastStepIndex: 0,
    });
  });

  it("does NOT emit onboarding_abandoned after completion", async () => {
    const { getByTestId, unmount } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });

    await act(async () => {
      getByTestId("close-wizard").click();
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith("onboarding_completed", expect.any(Object));
    });

    trackMock.mockClear();
    unmount();

    expect(trackMock).not.toHaveBeenCalledWith("onboarding_abandoned", expect.any(Object));
  });
});

describe("OnboardingFlow resume and legacy steps", () => {
  const defaultProps = {
    availability: {} as import("@shared/types").CliAvailability,
    onRefreshSettings: vi.fn(() => Promise.resolve()),
    hasAnySelectedAgent: true as boolean | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState });
  });

  it("resumes at agentSetup when persisted step is agentSetup", async () => {
    onboardingMock.get.mockResolvedValue({
      ...defaultOnboardingState,
      currentStep: "agentSetup",
      agentSetupIds: ["claude", "gemini"],
    });

    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });
  });

  it("resumes at agentSetup when persisted step is legacy agentSelection", async () => {
    onboardingMock.get.mockResolvedValue({
      ...defaultOnboardingState,
      currentStep: "agentSelection",
      agentSetupIds: [],
    });

    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });
  });

  it("falls back to agentSetup step when resuming with unknown step name", async () => {
    onboardingMock.get.mockResolvedValue({
      ...defaultOnboardingState,
      currentStep: "themeSelection",
    });

    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });
  });

  it("maps legacy 'welcome' step to agentSetup", async () => {
    onboardingMock.get.mockResolvedValue({
      ...defaultOnboardingState,
      currentStep: "welcome",
    });

    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });
  });

  it("renders nothing and skips hydration when DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS is enabled", async () => {
    // The component reads SKIP_FIRST_RUN_DIALOGS at module load, so we flip
    // the mock, reset the module cache, and re-import.
    isCanopyEnvEnabledMock.mockReturnValue(true);
    try {
      vi.resetModules();
      const { OnboardingFlow: IsolatedOnboardingFlow } = await import("../OnboardingFlow");
      const { baseElement } = await act(async () => {
        return render(<IsolatedOnboardingFlow {...defaultProps} />);
      });

      // No dialog, no progress indicator — nothing should render
      expect(
        baseElement.ownerDocument.querySelector('[data-testid="agent-setup-wizard"]')
      ).toBeNull();
      expect(baseElement.ownerDocument.querySelector('[data-testid="welcome-step"]')).toBeNull();
      expect(
        baseElement.ownerDocument.querySelector('[data-testid="onboarding-progress"]')
      ).toBeNull();

      // IPC hydration should be skipped entirely
      expect(onboardingMock.get).not.toHaveBeenCalled();
    } finally {
      isCanopyEnvEnabledMock.mockReturnValue(false);
      vi.resetModules();
    }
  });
});

describe("OnboardingFlow auto-open wizard on no selected agents", () => {
  const completedOnboardingState: OnboardingState = {
    ...defaultOnboardingState,
    completed: true,
    currentStep: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    onboardingMock.get.mockResolvedValue({ ...completedOnboardingState });
  });

  it("auto-opens wizard with isFirstRun=false when onboarding complete and no agents selected", async () => {
    const { getByTestId } = await act(async () => {
      return render(
        <OnboardingFlow
          availability={{} as import("@shared/types").CliAvailability}
          onRefreshSettings={vi.fn(() => Promise.resolve())}
          hasAnySelectedAgent={false}
        />
      );
    });

    await vi.waitFor(() => {
      const wizard = getByTestId("agent-setup-wizard");
      expect(wizard).toBeTruthy();
      expect(wizard.getAttribute("data-first-run")).toBe("false");
    });
  });

  it("calls onRefreshSettings when auto-opened wizard is closed", async () => {
    const refreshMock = vi.fn(() => Promise.resolve());
    const { getByTestId } = await act(async () => {
      return render(
        <OnboardingFlow
          availability={{} as import("@shared/types").CliAvailability}
          onRefreshSettings={refreshMock}
          hasAnySelectedAgent={false}
        />
      );
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });

    await act(async () => {
      getByTestId("close-wizard").click();
    });

    expect(refreshMock).toHaveBeenCalled();
  });

  it("does NOT auto-open wizard when hasAnySelectedAgent is null (loading)", async () => {
    const { baseElement } = await act(async () => {
      return render(
        <OnboardingFlow
          availability={{} as import("@shared/types").CliAvailability}
          onRefreshSettings={vi.fn(() => Promise.resolve())}
          hasAnySelectedAgent={null}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const wizard = baseElement.ownerDocument.querySelector('[data-testid="agent-setup-wizard"]');
    expect(wizard).toBeNull();
  });

  it("does NOT auto-open wizard when agents are selected", async () => {
    const { baseElement } = await act(async () => {
      return render(
        <OnboardingFlow
          availability={{} as import("@shared/types").CliAvailability}
          onRefreshSettings={vi.fn(() => Promise.resolve())}
          hasAnySelectedAgent={true}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const wizard = baseElement.ownerDocument.querySelector('[data-testid="agent-setup-wizard"]');
    expect(wizard).toBeNull();
  });

  it("does NOT auto-open wizard when onboarding is not complete", async () => {
    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState, completed: false });

    const { getByTestId } = await act(async () => {
      return render(
        <OnboardingFlow
          availability={{} as import("@shared/types").CliAvailability}
          onRefreshSettings={vi.fn(() => Promise.resolve())}
          hasAnySelectedAgent={false}
        />
      );
    });

    // With completed=false, it starts the first-run flow directly at agentSetup
    await vi.waitFor(() => {
      const wizard = getByTestId("agent-setup-wizard");
      expect(wizard).toBeTruthy();
      expect(wizard.getAttribute("data-first-run")).toBe("true");
    });
  });
});
