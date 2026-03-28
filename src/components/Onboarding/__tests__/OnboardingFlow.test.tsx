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
  checklist: {
    dismissed: false,
    celebrationShown: false,
    items: { openedProject: false, launchedAgent: false, createdWorktree: false },
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

vi.mock("@/components/Setup/AgentSelectionStep", () => ({
  AgentSelectionStep: vi.fn(
    ({ onContinue, onSkip }: { onContinue: (ids: string[]) => void; onSkip: () => void }) => (
      <div data-testid="agent-selection-step">
        <button data-testid="continue" onClick={() => onContinue([])}>
          Continue
        </button>
        <button data-testid="skip" onClick={() => onSkip()}>
          Skip
        </button>
      </div>
    )
  ),
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState });
  });

  it("renders progress indicator with 3 dots on first step", async () => {
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
    expect(dots).toHaveLength(3);
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

    // Advance from welcome to agentSelection
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

    // Complete the flow: welcome → skip agent selection
    await act(async () => {
      getByTestId("welcome-continue").click();
    });
    await vi.waitFor(() => {
      expect(getByTestId("agent-selection-step")).toBeTruthy();
    });
    await act(async () => {
      getByTestId("skip").click();
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
    expect(srText?.textContent).toBe("Step 1 of 3");
  });
});

describe("OnboardingFlow telemetry tracking", () => {
  const defaultProps = {
    availability: {} as import("@shared/types").CliAvailability,
    onRefreshSettings: vi.fn(() => Promise.resolve()),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState });
  });

  it("emits onboarding_step_viewed when first step renders", async () => {
    await act(async () => {
      render(<OnboardingFlow {...defaultProps} />);
    });

    // Wait for hydration and step_viewed event
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

  it("emits onboarding_step_skipped when agent selection is skipped", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    // Wait for hydration
    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith("onboarding_step_viewed", expect.any(Object));
    });

    // Advance through welcome
    await act(async () => {
      getByTestId("welcome-continue").click();
    });

    // Wait for agent selection step to render
    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith("onboarding_step_viewed", {
        step: "agentSelection",
        stepIndex: 1,
      });
    });

    trackMock.mockClear();

    // Skip agent selection
    await act(async () => {
      getByTestId("skip").click();
    });

    expect(trackMock).toHaveBeenCalledWith("onboarding_step_skipped", {
      step: "agentSelection",
    });
  });

  it("emits onboarding_completed when flow finishes", async () => {
    const { getByTestId } = await act(async () => {
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

    // Wait for agent selection
    await vi.waitFor(() => {
      expect(getByTestId("agent-selection-step")).toBeTruthy();
    });

    // Skip agent selection (skips agent setup too)
    await act(async () => {
      getByTestId("skip").click();
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith(
        "onboarding_completed",
        expect.objectContaining({ totalSteps: 3 })
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

    // Wait for agent selection
    await vi.waitFor(() => {
      expect(getByTestId("agent-selection-step")).toBeTruthy();
    });

    // Skip to complete flow
    await act(async () => {
      getByTestId("skip").click();
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

describe("OnboardingFlow agent setup persistence", () => {
  const defaultProps = {
    availability: {} as import("@shared/types").CliAvailability,
    onRefreshSettings: vi.fn(() => Promise.resolve()),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState });
  });

  it("persists agentSetupIds when advancing from agent selection", async () => {
    // Mock AgentSelectionStep to return specific agent IDs
    const { AgentSelectionStep } = await import("@/components/Setup/AgentSelectionStep");
    const mockSelection = AgentSelectionStep as unknown as ReturnType<typeof vi.fn>;
    mockSelection.mockImplementation(({ onContinue }: { onContinue: (ids: string[]) => void }) => (
      <div data-testid="agent-selection-step">
        <button data-testid="continue-with-agents" onClick={() => onContinue(["claude", "gemini"])}>
          Continue
        </button>
      </div>
    ));

    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalled();
    });

    // Advance to agent selection
    await act(async () => {
      getByTestId("welcome-continue").click();
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-selection-step")).toBeTruthy();
    });

    // Continue with specific agents
    await act(async () => {
      getByTestId("continue-with-agents").click();
    });

    // setStep should be called with the object payload containing agentSetupIds
    await vi.waitFor(() => {
      expect(onboardingMock.setStep).toHaveBeenCalledWith({
        step: "agentSetup",
        agentSetupIds: ["claude", "gemini"],
      });
    });
  });

  it("persists empty agentSetupIds when skipping agent selection", async () => {
    // Restore default mock for AgentSelectionStep (previous test may have overridden it)
    const { AgentSelectionStep } = await import("@/components/Setup/AgentSelectionStep");
    const mockSelection = AgentSelectionStep as unknown as ReturnType<typeof vi.fn>;
    mockSelection.mockImplementation(
      ({ onContinue, onSkip }: { onContinue: (ids: string[]) => void; onSkip: () => void }) => (
        <div data-testid="agent-selection-step">
          <button data-testid="continue" onClick={() => onContinue([])}>
            Continue
          </button>
          <button data-testid="skip" onClick={() => onSkip()}>
            Skip
          </button>
        </div>
      )
    );

    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalled();
    });

    // Advance to agent selection
    await act(async () => {
      getByTestId("welcome-continue").click();
    });

    await vi.waitFor(() => {
      expect(getByTestId("agent-selection-step")).toBeTruthy();
    });

    // Skip agent selection — should persist empty array and skip agentSetup step
    await act(async () => {
      getByTestId("skip").click();
    });

    // setStep should NOT be called with "agentSetup" since skip bypasses it
    // It should complete the flow since agentSetup is the last step and it's skipped
    await vi.waitFor(() => {
      expect(onboardingMock.complete).toHaveBeenCalled();
    });
  });

  it("resumes at agentSetup with persisted agent IDs after restart", async () => {
    onboardingMock.get.mockResolvedValue({
      ...defaultOnboardingState,
      currentStep: "agentSetup",
      agentSetupIds: ["claude", "gemini"],
    });

    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    // Should resume at agentSetup wizard
    await vi.waitFor(() => {
      expect(getByTestId("agent-setup-wizard")).toBeTruthy();
    });
  });

  it("falls back to agentSelection when resuming at agentSetup with empty IDs", async () => {
    onboardingMock.get.mockResolvedValue({
      ...defaultOnboardingState,
      currentStep: "agentSetup",
      agentSetupIds: [],
    });

    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    // Should fall back to agentSelection since no IDs were persisted
    await vi.waitFor(() => {
      expect(getByTestId("agent-selection-step")).toBeTruthy();
    });
  });

  it("falls back to welcome step when resuming with legacy step name", async () => {
    onboardingMock.get.mockResolvedValue({
      ...defaultOnboardingState,
      currentStep: "themeSelection",
    });

    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    // Old "themeSelection" step not in new STEP_ORDER → falls back to STEP_ORDER[0] ("welcome")
    await vi.waitFor(() => {
      expect(getByTestId("welcome-step")).toBeTruthy();
    });
  });
});
