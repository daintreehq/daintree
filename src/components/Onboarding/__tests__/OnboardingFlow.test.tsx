// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OnboardingState } from "@shared/types";

const trackMock = vi.fn(() => Promise.resolve());

const defaultOnboardingState: OnboardingState = {
  schemaVersion: 1,
  completed: false,
  currentStep: null,
  migratedFromLocalStorage: true,
  firstRunToastSeen: false,
};

const onboardingMock = {
  get: vi.fn(() => Promise.resolve({ ...defaultOnboardingState })),
  setStep: vi.fn(() => Promise.resolve()),
  complete: vi.fn(() => Promise.resolve()),
  migrate: vi.fn(() => Promise.resolve({ ...defaultOnboardingState })),
};

const telemetryMock = {
  get: vi.fn(() => Promise.resolve({ enabled: false, hasSeenPrompt: false })),
  setEnabled: vi.fn(() => Promise.resolve()),
  markPromptShown: vi.fn(() => Promise.resolve()),
  track: trackMock,
};

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: {
    onboarding: onboardingMock,
    telemetry: telemetryMock,
  },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

vi.mock("@/utils/env", () => ({
  isCanopyEnvEnabled: () => false,
}));

vi.mock("../TelemetryConsentStep", () => ({
  TelemetryConsentStep: vi.fn(({ onDismiss }: { onDismiss: (enabled: boolean) => void }) => (
    <div data-testid="telemetry-step">
      <button data-testid="accept" onClick={() => onDismiss(true)}>
        Accept
      </button>
      <button data-testid="decline" onClick={() => onDismiss(false)}>
        Decline
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
        step: "telemetry",
        stepIndex: 0,
      });
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

    // Accept telemetry to advance to agent selection
    await act(async () => {
      getByTestId("accept").click();
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

    // Accept telemetry
    await act(async () => {
      getByTestId("accept").click();
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
      lastStep: "telemetry",
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

    // Accept telemetry
    await act(async () => {
      getByTestId("accept").click();
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
});
