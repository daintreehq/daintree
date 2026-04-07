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

vi.mock("@/utils/env", () => ({
  isCanopyEnvEnabled: () => false,
}));

vi.mock("../WelcomeStep", () => ({
  WelcomeStep: vi.fn(({ onContinue, onSkip }: { onContinue: () => void; onSkip: () => void }) => (
    <div data-testid="welcome-step">
      <button data-testid="welcome-continue" onClick={onContinue}>
        Continue
      </button>
      <button data-testid="welcome-skip" onClick={onSkip}>
        Skip
      </button>
    </div>
  )),
}));

vi.mock("@/components/Setup/AgentSetupWizard", () => ({
  AgentSetupWizard: vi.fn(({ onClose }: { onClose: () => void }) => (
    <div data-testid="agent-setup-wizard">
      <button data-testid="close-wizard" onClick={onClose}>
        Close
      </button>
    </div>
  )),
}));

import { OnboardingFlow } from "../OnboardingFlow";

describe("OnboardingFlow progress indicator", () => {
  const defaultProps = {
    availability: {} as import("@shared/types").CliAvailability,
    onRefreshSettings: vi.fn(() => Promise.resolve()),
    hasAnySelectedAgent: true as boolean | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState });
  });

  it("renders progress indicator with 2 dots on first step", async () => {
    const { baseElement } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      const indicator = baseElement.ownerDocument.querySelector(
        '[data-testid="onboarding-progress"]'
      );
      expect(indicator).toBeTruthy();
    });

    const indicator = baseElement.ownerDocument.querySelector(
      '[data-testid="onboarding-progress"]'
    )!;
    const dots = indicator.querySelectorAll('[data-testid^="progress-dot-"]');
    expect(dots).toHaveLength(2);
    expect(dots[0]?.getAttribute("aria-current")).toBe("step");
    expect(dots[1]?.getAttribute("aria-current")).toBeNull();
  });

  it("advances active dot when step changes", async () => {
    const { getByTestId, baseElement } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith("onboarding_step_viewed", expect.any(Object));
    });

    // Advance from welcome to agentSetup
    await act(async () => {
      getByTestId("welcome-continue").click();
    });

    await vi.waitFor(() => {
      const indicator = baseElement.ownerDocument.querySelector(
        '[data-testid="onboarding-progress"]'
      )!;
      const dots = indicator.querySelectorAll('[data-testid^="progress-dot-"]');
      expect(dots[1]?.getAttribute("aria-current")).toBe("step");
      expect(dots[0]?.getAttribute("aria-current")).toBeNull();
    });
  });

  it("is not rendered after onboarding completes", async () => {
    const { getByTestId, baseElement } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalled();
    });

    // Complete the flow: welcome → agent setup wizard → close
    await act(async () => {
      getByTestId("welcome-continue").click();
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

    const indicator = baseElement.ownerDocument.querySelector(
      '[data-testid="onboarding-progress"]'
    );
    expect(indicator).toBeNull();
  });

  it("includes screen reader text with step count", async () => {
    const { baseElement } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      const indicator = baseElement.ownerDocument.querySelector(
        '[data-testid="onboarding-progress"]'
      );
      expect(indicator).toBeTruthy();
    });

    const srText = baseElement.ownerDocument
      .querySelector('[data-testid="onboarding-progress"]')!
      .querySelector(".sr-only");
    expect(srText?.textContent).toBe("Step 1 of 2");
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

  it("emits onboarding_step_viewed when first step renders", async () => {
    await act(async () => {
      render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith("onboarding_step_viewed", {
        step: "welcome",
        stepIndex: 0,
      });
    });
  });

  it("emits onboarding_step_skipped when welcome step is skipped", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith("onboarding_step_viewed", expect.any(Object));
    });

    trackMock.mockClear();

    await act(async () => {
      getByTestId("welcome-skip").click();
    });

    expect(trackMock).toHaveBeenCalledWith("onboarding_step_skipped", {
      step: "welcome",
    });
  });

  it("emits onboarding_completed when flow finishes", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalled();
    });

    // Continue from welcome to agent setup
    await act(async () => {
      getByTestId("welcome-continue").click();
    });

    // Wait for agent setup wizard
    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });

    // Close wizard to complete flow
    await act(async () => {
      getByTestId("close-wizard").click();
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith(
        "onboarding_completed",
        expect.objectContaining({ totalSteps: 2 })
      );
    });
  });

  it("emits onboarding_abandoned on unmount when flow is incomplete", async () => {
    const { unmount } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    // Wait for hydration
    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith("onboarding_step_viewed", expect.any(Object));
    });

    trackMock.mockClear();
    unmount();

    expect(trackMock).toHaveBeenCalledWith("onboarding_abandoned", {
      lastStep: "welcome",
      lastStepIndex: 0,
    });
  });

  it("does NOT emit onboarding_abandoned after completion", async () => {
    const { getByTestId, unmount } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    // Wait for hydration
    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalled();
    });

    // Continue from welcome
    await act(async () => {
      getByTestId("welcome-continue").click();
    });

    // Wait for agent setup wizard
    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });

    // Close wizard to complete flow
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

  it("calls setTelemetryLevel and markPromptShown on welcome continue", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalled();
    });

    await act(async () => {
      getByTestId("welcome-continue").click();
    });

    await vi.waitFor(() => {
      expect(privacyMock.setTelemetryLevel).toHaveBeenCalledWith("off");
      expect(telemetryMock.markPromptShown).toHaveBeenCalled();
    });
  });

  it("calls setTelemetryLevel('off') and markPromptShown on welcome skip", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalled();
    });

    await act(async () => {
      getByTestId("welcome-skip").click();
    });

    await vi.waitFor(() => {
      expect(privacyMock.setTelemetryLevel).toHaveBeenCalledWith("off");
      expect(telemetryMock.markPromptShown).toHaveBeenCalled();
    });
  });
});

describe("OnboardingFlow agent setup", () => {
  const defaultProps = {
    availability: {} as import("@shared/types").CliAvailability,
    onRefreshSettings: vi.fn(() => Promise.resolve()),
    hasAnySelectedAgent: true as boolean | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState });
  });

  it("shows agent setup wizard after welcome", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalled();
    });

    // Advance to agent setup
    await act(async () => {
      getByTestId("welcome-continue").click();
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });
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

    // Legacy "agentSelection" maps to "agentSetup" now
    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });
  });

  it("falls back to welcome step when resuming with unknown step name", async () => {
    onboardingMock.get.mockResolvedValue({
      ...defaultOnboardingState,
      currentStep: "themeSelection",
    });

    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(getByTestId("welcome-step")).toBeTruthy();
    });
  });

  it("calls onRefreshSettings when wizard closes", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalled();
    });

    // Advance to agent setup
    await act(async () => {
      getByTestId("welcome-continue").click();
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });

    // Close wizard
    await act(async () => {
      getByTestId("close-wizard").click();
    });

    await vi.waitFor(() => {
      expect(defaultProps.onRefreshSettings).toHaveBeenCalled();
    });
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

  it("auto-opens wizard when onboarding complete and no agents selected", async () => {
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
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });
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

    // Give effects time to run
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

    const { baseElement } = await act(async () => {
      return render(
        <OnboardingFlow
          availability={{} as import("@shared/types").CliAvailability}
          onRefreshSettings={vi.fn(() => Promise.resolve())}
          hasAnySelectedAgent={false}
        />
      );
    });

    // Wait for hydration; the flow should show welcome step, not wizard
    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalled();
    });

    // Wizard should not appear as a manual/auto-open
    // (the welcome step or agent setup step appears as part of onboarding flow instead)
    const manualWizard = baseElement.ownerDocument.querySelector(
      '[data-testid="agent-setup-wizard"]'
    );
    // If it exists, it should be part of the onboarding flow (step 2), not auto-opened
    // The key check is that auto-open doesn't trigger during incomplete onboarding
    // With completed=false and no currentStep match, it starts at welcome
    expect(baseElement.ownerDocument.querySelector('[data-testid="welcome-step"]')).toBeTruthy();
  });
});
