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
  seenAgentIds: [],
  welcomeCardDismissed: false,
  setupBannerDismissed: false,
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
  dismissSetupBanner: vi.fn(() => Promise.resolve({ ...defaultOnboardingState })),
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

// Capture the real addEventListener so the component can actually subscribe to
// the open-wizard custom event within the jsdom window.
const openWizardListeners = new Set<(e: Event) => void>();

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: {
    onboarding: onboardingMock,
    telemetry: telemetryMock,
    privacy: privacyMock,
  },
  addEventListener: vi.fn((name: string, listener: (e: Event) => void) => {
    if (name === "daintree:open-agent-setup-wizard") {
      openWizardListeners.add(listener);
    }
  }),
  removeEventListener: vi.fn((name: string, listener: (e: Event) => void) => {
    if (name === "daintree:open-agent-setup-wizard") {
      openWizardListeners.delete(listener);
    }
  }),
  dispatchEvent: vi.fn((event: Event) => {
    if (event.type === "daintree:open-agent-setup-wizard") {
      for (const l of openWizardListeners) l(event);
    }
    return true;
  }),
});

function fireOpenWizard(detail?: { isFirstRun?: boolean; returnToPanelPalette?: boolean }) {
  const evt = new CustomEvent("daintree:open-agent-setup-wizard", { detail });
  for (const l of openWizardListeners) l(evt);
}

const { isDaintreeEnvEnabledMock } = vi.hoisted(() => ({
  isDaintreeEnvEnabledMock: vi.fn((_key: string): boolean => false),
}));
vi.mock("@/utils/env", () => ({
  isDaintreeEnvEnabled: (key: string) => isDaintreeEnvEnabledMock(key),
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

const { dismissSetupBannerHookMock } = vi.hoisted(() => ({
  dismissSetupBannerHookMock: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/hooks/app/useAgentDiscoveryOnboarding", () => ({
  dismissSetupBanner: dismissSetupBannerHookMock,
}));

import { OnboardingFlow } from "../OnboardingFlow";

describe("OnboardingFlow first-run", () => {
  const defaultProps = {
    availability: {} as import("@shared/types").CliAvailability,
    onRefreshSettings: vi.fn(() => Promise.resolve()),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    openWizardListeners.clear();
    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState });
  });

  it("does NOT render AgentSetupWizard on first run", async () => {
    const { baseElement } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    // Give hydration a tick to complete.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(
      baseElement.ownerDocument.querySelector('[data-testid="agent-setup-wizard"]')
    ).toBeNull();
  });

  it("opens wizard with isFirstRun=true when banner fires event with that detail", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      fireOpenWizard({ isFirstRun: true });
    });

    const wizard = getByTestId("agent-setup-wizard");
    expect(wizard.getAttribute("data-first-run")).toBe("true");
  });

  it("opens wizard with isFirstRun=false when event has no detail (e.g. Settings)", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      fireOpenWizard();
    });

    const wizard = getByTestId("agent-setup-wizard");
    expect(wizard.getAttribute("data-first-run")).toBe("false");
  });

  it("completes onboarding when wizard closes after first-run banner open", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      fireOpenWizard({ isFirstRun: true });
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
    expect(onboardingMock.complete).toHaveBeenCalled();
  });

  it("dismisses the setup banner via the shared hook when first-run wizard closes", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      fireOpenWizard({ isFirstRun: true });
    });

    await act(async () => {
      getByTestId("close-wizard").click();
    });

    await vi.waitFor(() => {
      expect(dismissSetupBannerHookMock).toHaveBeenCalled();
    });
  });

  it("does NOT call onboarding.complete when a non-first-run wizard closes", async () => {
    // Simulates Settings/toolbar re-opening the wizard after onboarding was
    // already completed. Those opens should not re-fire first-run telemetry.
    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState, completed: true });

    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      fireOpenWizard();
    });

    await act(async () => {
      getByTestId("close-wizard").click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(onboardingMock.complete).not.toHaveBeenCalled();
  });

  it("calls onRefreshSettings when wizard closes", async () => {
    const { getByTestId } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      fireOpenWizard({ isFirstRun: true });
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    openWizardListeners.clear();
    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState });
  });

  it("emits onboarding_step_viewed when the banner opens the wizard", async () => {
    await act(async () => {
      render(<OnboardingFlow {...defaultProps} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      fireOpenWizard({ isFirstRun: true });
    });

    await vi.waitFor(() => {
      expect(trackMock).toHaveBeenCalledWith("onboarding_step_viewed", {
        step: "agentSetup",
        stepIndex: 0,
      });
    });
  });

  it("does NOT emit onboarding_step_viewed on first paint (no wizard yet)", async () => {
    await act(async () => {
      render(<OnboardingFlow {...defaultProps} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(trackMock).not.toHaveBeenCalledWith("onboarding_step_viewed", expect.any(Object));
  });

  it("emits onboarding_abandoned on unmount when wizard was opened but not completed", async () => {
    const { unmount } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      fireOpenWizard({ isFirstRun: true });
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

  it("does NOT emit onboarding_completed when complete() persistence rejects", async () => {
    onboardingMock.complete.mockRejectedValueOnce(new Error("IPC down"));

    const { getByTestId, unmount } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      fireOpenWizard({ isFirstRun: true });
    });

    await act(async () => {
      getByTestId("close-wizard").click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Telemetry fires only after successful persistence.
    expect(trackMock).not.toHaveBeenCalledWith("onboarding_completed", expect.any(Object));

    // Abandonment telemetry still fires on unmount since completedRef was not
    // flipped when persistence failed.
    trackMock.mockClear();
    unmount();
    expect(trackMock).toHaveBeenCalledWith("onboarding_abandoned", expect.any(Object));
  });

  it("does NOT emit onboarding_abandoned after completion", async () => {
    const { getByTestId, unmount } = await act(async () => {
      return render(<OnboardingFlow {...defaultProps} />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      fireOpenWizard({ isFirstRun: true });
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

describe("OnboardingFlow E2E skip", () => {
  const defaultProps = {
    availability: {} as import("@shared/types").CliAvailability,
    onRefreshSettings: vi.fn(() => Promise.resolve()),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    openWizardListeners.clear();
    onboardingMock.get.mockResolvedValue({ ...defaultOnboardingState });
  });

  it("renders nothing and skips hydration when DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS is enabled", async () => {
    // The component reads SKIP_FIRST_RUN_DIALOGS at module load, so we flip
    // the mock, reset the module cache, and re-import.
    isDaintreeEnvEnabledMock.mockReturnValue(true);
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

      // IPC hydration should be skipped entirely
      expect(onboardingMock.get).not.toHaveBeenCalled();
    } finally {
      isDaintreeEnvEnabledMock.mockReturnValue(false);
      vi.resetModules();
    }
  });
});
