import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { AgentCliStep } from "./AgentCliStep";
import { SystemRequirementsSection } from "./SystemRequirementsSection";
import { AGENT_REGISTRY } from "@/config/agents";
import { BrandMark } from "@/components/icons";
import { AgentCard } from "@/components/agents/AgentCard";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import { useAgentSettingsStore } from "@/store";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { cliAvailabilityClient } from "@/clients";
import { logError } from "@/utils/logger";
import type { CliAvailability } from "@shared/types";
import { useAgentSetupPoll } from "./useAgentSetupPoll";
import { isAgentInstalled, isAgentLaunchable } from "../../../shared/utils/agentAvailability";
import { Sparkles, ChevronLeft, ChevronRight, ArrowRight, Check, Sun, Moon } from "lucide-react";
import { AnimatePresence, m, useReducedMotion, type Variants } from "framer-motion";
import { Plug } from "@/components/icons";
import { UI_ENTER_DURATION, UI_EXIT_DURATION } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import type { AppColorScheme } from "@shared/types/appTheme";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";

const AGENT_ORDER = LAUNCHABLE_AGENT_IDS;

const daintreeScheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
const bondiScheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === "bondi")!;

function ThemeMockup({ scheme }: { scheme: AppColorScheme }) {
  const t = scheme.tokens;
  return (
    <div
      className="rounded-lg overflow-hidden border"
      style={{ backgroundColor: t["surface-canvas"], borderColor: t["border-default"] }}
    >
      <div
        className="flex items-center gap-1 px-2 py-1"
        style={{
          backgroundColor: t["surface-panel-elevated"],
          borderBottom: `1px solid ${t["border-default"]}`,
        }}
      >
        <div className="flex gap-1">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: t["status-danger"] }}
          />
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: t["status-warning"] }}
          />
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: t["status-success"] }}
          />
        </div>
        <div className="flex-1" />
        <div className="text-[6px] font-medium tracking-wide" style={{ color: t["text-muted"] }}>
          Daintree
        </div>
        <div className="flex-1" />
      </div>

      <div className="flex" style={{ height: 100 }}>
        <div
          className="flex flex-col items-center gap-1.5 py-2 px-1"
          style={{
            backgroundColor: t["surface-sidebar"],
            borderRight: `1px solid ${t["border-default"]}`,
            width: 24,
          }}
        >
          <div
            className="w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: t["accent-primary"] }}
          />
          <div
            className="w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: t["text-muted"], opacity: 0.5 }}
          />
          <div
            className="w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: t["text-muted"], opacity: 0.5 }}
          />
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div
            className="flex items-center"
            style={{ borderBottom: `1px solid ${t["border-default"]}` }}
          >
            <div
              className="px-2 py-0.5 text-[6px]"
              style={{
                backgroundColor: t["surface-panel"],
                color: t["text-primary"],
                borderBottom: `1.5px solid ${t["accent-primary"]}`,
              }}
            >
              main.ts
            </div>
            <div
              className="px-2 py-0.5 text-[6px]"
              style={{
                backgroundColor: t["surface-canvas"],
                color: t["text-muted"],
              }}
            >
              config.ts
            </div>
          </div>

          <div
            className="flex-1 px-2 py-1.5 font-mono text-[7px] leading-[11px] space-y-px overflow-hidden"
            style={{ backgroundColor: t["surface-panel"] }}
          >
            <div>
              <span style={{ color: t["syntax-keyword"] }}>import</span>
              <span style={{ color: t["syntax-punctuation"] }}>{" { "}</span>
              <span style={{ color: t["syntax-function"] }}>app</span>
              <span style={{ color: t["syntax-punctuation"] }}>{" } "}</span>
              <span style={{ color: t["syntax-keyword"] }}>from</span>
              <span style={{ color: t["syntax-string"] }}>{" 'electron'"}</span>
            </div>
            <div style={{ height: 3 }} />
            <div>
              <span style={{ color: t["syntax-keyword"] }}>const</span>
              <span style={{ color: t["text-primary"] }}> win</span>
              <span style={{ color: t["syntax-operator"] }}> = </span>
              <span style={{ color: t["syntax-keyword"] }}>new</span>
              <span style={{ color: t["syntax-function"] }}> Window</span>
              <span style={{ color: t["syntax-punctuation"] }}>({"{"}</span>
            </div>
            <div>
              <span style={{ color: t["text-primary"] }}>{"  "}</span>
              <span style={{ color: t["text-primary"] }}>width</span>
              <span style={{ color: t["syntax-punctuation"] }}>: </span>
              <span style={{ color: t["syntax-number"] }}>1200</span>
              <span style={{ color: t["syntax-punctuation"] }}>,</span>
            </div>
            <div>
              <span style={{ color: t["syntax-comment"] }}>{"  // "}</span>
              <span style={{ color: t["syntax-comment"] }}>ready</span>
            </div>
          </div>

          <div
            className="px-2 py-1 font-mono text-[7px] leading-[10px]"
            style={{
              backgroundColor: t["surface-canvas"],
              borderTop: `1px solid ${t["border-default"]}`,
            }}
          >
            <div>
              <span style={{ color: t["terminal-green"] }}>$</span>
              <span style={{ color: t["text-primary"] }}> npm run dev</span>
            </div>
            <div>
              <span style={{ color: t["terminal-cyan"] }}>ready</span>
              <span style={{ color: t["text-muted"] }}> in 240ms</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Tier arrays for the agents step — featured agents get prominent display,
// the rest fall into "More agents". New built-in agents automatically land in MORE_AGENT_IDS.
export const FEATURED_AGENT_IDS: readonly string[] = ["claude", "gemini", "codex"];
export const MORE_AGENT_IDS: readonly string[] = LAUNCHABLE_AGENT_IDS.filter(
  (id) => !(FEATURED_AGENT_IDS as readonly string[]).includes(id)
);

export function sortTierByInstalled<T extends string>(
  ids: readonly T[],
  availability: CliAvailability
): T[] {
  const installed: T[] = [];
  const notInstalled: T[] = [];
  for (const id of ids) {
    if (isAgentInstalled(availability[id])) {
      installed.push(id);
    } else {
      notInstalled.push(id);
    }
  }
  return [...installed, ...notInstalled];
}

// --- Step transition variants ---

const stepVariants: Variants = {
  initial: (direction: number) => ({
    x: `${direction * 30}%`,
    opacity: 0,
  }),
  animate: {
    x: 0,
    opacity: 1,
    transition: { duration: UI_ENTER_DURATION / 1000, ease: [0.16, 1, 0.3, 1] },
  },
  exit: (direction: number) => ({
    x: `${direction * -30}%`,
    opacity: 0,
    transition: { duration: UI_EXIT_DURATION / 1000, ease: [0.2, 0, 0.7, 0] },
  }),
};

const reducedStepVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

// --- Wizard state machine ---

export type WizardStep =
  | { type: "appearance" }
  | { type: "agents" }
  | { type: "privacy" }
  | { type: "cli" }
  | { type: "permissions" }
  | { type: "complete" };

export interface WizardState {
  step: WizardStep;
  history: WizardStep[];
  availability: CliAvailability;
  selections: Record<string, boolean>;
  selectionsInitialized: boolean;
  isFirstRun: boolean;
}

export type WizardAction =
  | { type: "APPEARANCE_CONTINUE" }
  | { type: "AGENTS_CONTINUE" }
  | { type: "PRIVACY_CONTINUE" }
  | { type: "CLI_CONTINUE" }
  | { type: "PERMISSIONS_CONTINUE" }
  | { type: "BACK" }
  | { type: "SET_AVAILABILITY"; payload: CliAvailability }
  | { type: "INIT_SELECTIONS"; payload: Record<string, boolean> }
  | { type: "TOGGLE_SELECTION"; agentId: string; checked: boolean }
  | { type: "RESET"; availability: CliAvailability; isFirstRun: boolean };

// First-run walks every step (appearance → agents → privacy → cli →
// permissions → complete); re-runs from Settings start at `agents` and skip the
// first-run-only consent steps (privacy, permissions — returning users already
// have those toggles in Settings). The `cli` step is conditionally skipped when
// all selected agents are already installed, but the dot count reflects the
// maximum flow length — mirroring the pre-split behavior where the skippable
// `cli` step still counted toward the total.
export function flowSteps(isFirstRun: boolean): WizardStep["type"][] {
  return isFirstRun
    ? ["appearance", "agents", "privacy", "cli", "permissions", "complete"]
    : ["agents", "cli", "complete"];
}

export function buildInitialState(availability: CliAvailability, isFirstRun = false): WizardState {
  return {
    step: { type: isFirstRun ? "appearance" : "agents" },
    history: [],
    availability,
    selections: {},
    selectionsInitialized: false,
    isFirstRun,
  };
}

// The cli step is skipped when every selected agent is already launchable —
// there is nothing left to install. First-run users must still pass through the
// global permissions consent gate before the summary even when cli is skipped;
// returning users go straight to complete.
function resolvePostInstallStep(state: WizardState): WizardStep {
  const selectedIds = Object.keys(state.selections).filter((id) => state.selections[id]);
  const allSelectedInstalled =
    selectedIds.length > 0 && selectedIds.every((id) => isAgentLaunchable(state.availability[id]));
  if (allSelectedInstalled) {
    return state.isFirstRun ? { type: "permissions" } : { type: "complete" };
  }
  return { type: "cli" };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "APPEARANCE_CONTINUE":
      return {
        ...state,
        step: { type: "agents" },
        history: [...state.history, state.step],
      };

    case "AGENTS_CONTINUE":
      // First-run users get the privacy consent step before install/summary;
      // re-runs branch straight to cli/complete.
      return {
        ...state,
        step: state.isFirstRun ? { type: "privacy" } : resolvePostInstallStep(state),
        history: [...state.history, state.step],
      };

    case "PRIVACY_CONTINUE":
      return {
        ...state,
        step: resolvePostInstallStep(state),
        history: [...state.history, state.step],
      };

    case "CLI_CONTINUE":
      // First-run users get the global skip-permissions consent step before the
      // summary; re-runs branch straight to complete (the toggle lives in
      // Settings for returning users).
      return {
        ...state,
        step: state.isFirstRun ? { type: "permissions" } : { type: "complete" },
        history: [...state.history, state.step],
      };

    case "PERMISSIONS_CONTINUE":
      return {
        ...state,
        step: { type: "complete" },
        history: [...state.history, state.step],
      };

    case "BACK": {
      if (state.history.length === 0) return state;
      const newHistory = [...state.history];
      const prevStep = newHistory.pop()!;
      return {
        ...state,
        step: prevStep,
        history: newHistory,
      };
    }

    case "SET_AVAILABILITY":
      return { ...state, availability: action.payload };

    case "INIT_SELECTIONS":
      return {
        ...state,
        selections: action.payload,
        selectionsInitialized: true,
      };

    case "TOGGLE_SELECTION":
      return {
        ...state,
        selections: { ...state.selections, [action.agentId]: action.checked },
      };

    case "RESET":
      return buildInitialState(action.availability, action.isFirstRun);

    default:
      return state;
  }
}

// --- Component ---

interface AgentSetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  initialAvailability?: CliAvailability;
  isFirstRun?: boolean;
  onStepChange?: (step: WizardStep) => void;
}

export function AgentSetupWizard({
  isOpen,
  onClose,
  initialAvailability,
  isFirstRun = false,
  onStepChange,
}: AgentSetupWizardProps) {
  const [state, dispatch] = useReducer(
    wizardReducer,
    initialAvailability ?? ({} as CliAvailability),
    (avail) => buildInitialState(avail, isFirstRun)
  );

  const [hasFatalHealthFailure, setHasFatalHealthFailure] = useState(false);
  const [isHealthChecking, setIsHealthChecking] = useState(true);

  const { setAgentPinned, setGlobalSkipPermissions } = useAgentSettingsStore();
  const isAvailabilityLoading = useCliAvailabilityStore((s) => s.isLoading || s.isRefreshing);
  const [isSaving, setIsSaving] = useState(false);

  // Theme state (first-run only)
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const setSelectedSchemeId = useAppThemeStore((s) => s.setSelectedSchemeId);
  const setSelectedSchemeIdSilent = useAppThemeStore((s) => s.setSelectedSchemeIdSilent);
  const hasAutoSelected = useRef(false);

  // Global skip-permissions state (first-run only). Default off — silence is not
  // consent. Committed via setGlobalSkipPermissions only on Continue.
  const [permissionsEnabled, setPermissionsEnabled] = useState(false);

  // Telemetry state (first-run only)
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const telemetryCommittedRef = useRef(false);
  // Tracks whether the user explicitly engaged the privacy toggle (in either
  // direction). Distinct from `telemetryCommittedRef`: silent close paths still
  // commit telemetry off, but only fire the inbox confirmation when the user
  // never touched the toggle — silence is not consent.
  const telemetryToggleTouchedRef = useRef(false);

  const isOpenRef = useRef(isOpen);
  const initRef = useRef(false);
  const directionRef = useRef<1 | -1>(1);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  // Reset wizard state when reopened
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      dispatch({
        type: "RESET",
        availability: initialAvailability ?? ({} as CliAvailability),
        isFirstRun,
      });
      initRef.current = false;
      hasAutoSelected.current = false;
      telemetryCommittedRef.current = false;
      telemetryToggleTouchedRef.current = false;
      setTelemetryEnabled(false);
      setPermissionsEnabled(false);
      void useAgentSettingsStore.getState().initialize();
      directionRef.current = 1;
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, initialAvailability, isFirstRun]);

  // Poll availability — paused when document is hidden
  useAgentSetupPoll(isOpen, (result) => {
    dispatch({ type: "SET_AVAILABILITY", payload: result });
  });

  // Initialize selections once when availability is ready
  useEffect(() => {
    if (!isOpen || initRef.current || state.selectionsInitialized) return;
    if (isAvailabilityLoading) return;

    initRef.current = true;
    const initial: Record<string, boolean> = {};
    for (const agentId of AGENT_ORDER) {
      initial[agentId] = isAgentLaunchable(state.availability[agentId]);
    }
    dispatch({ type: "INIT_SELECTIONS", payload: initial });
  }, [isOpen, isAvailabilityLoading, state.availability, state.selectionsInitialized]);

  // Auto-select theme based on OS preference (first-run only, once)
  useEffect(() => {
    if (!isFirstRun || !isOpen || hasAutoSelected.current) return;
    if (state.step.type !== "appearance") return;
    hasAutoSelected.current = true;
    const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    const targetId = prefersLight ? "bondi" : "daintree";
    if (selectedSchemeId !== targetId) {
      // Auto-select mirrors OS appearance — not a direct user pick, so use the
      // silent setter to avoid polluting the recently-used list. The wizard has
      // already painted, so crossfade the swap instead of cutting it.
      setSelectedSchemeIdSilent(targetId, { crossfade: true });
      appThemeClient
        .setColorScheme(targetId)
        .catch((err) => logError("Failed to set color scheme", err));
    }
  }, [isFirstRun, isOpen, state.step.type, selectedSchemeId, setSelectedSchemeIdSilent]);

  const handleThemeSelect = useCallback(
    async (id: string) => {
      setSelectedSchemeId(id);
      try {
        await appThemeClient.setColorScheme(id);
      } catch (error) {
        logError("Failed to persist app theme", error);
      }
    },
    [setSelectedSchemeId]
  );

  // Returns true when this call actually committed the preference this turn
  // (vs returning early because it was already persisted earlier in the
  // session). Callers use the return value to gate the silent-default inbox
  // confirmation. The two IPCs are intentionally NOT treated as one atomic
  // unit: a successful preference write must still surface the inbox
  // confirmation even if the prompt-shown bookkeeping fails — otherwise a
  // partial failure would silently re-introduce the bug this guard exists
  // to prevent.
  const commitTelemetry = useCallback(async (level: "errors" | "off"): Promise<boolean> => {
    if (telemetryCommittedRef.current) return false;
    try {
      await window.electron.privacy.setTelemetryLevel(level);
      telemetryCommittedRef.current = true;
    } catch (error) {
      logError("Failed to commit telemetry preference", error);
      return false;
    }
    try {
      await window.electron.telemetry.markPromptShown();
    } catch (error) {
      // Non-fatal: the preference is persisted; the prompt will re-show next
      // launch, but the user's choice this session is honored.
      logError("Failed to mark telemetry prompt shown", error);
    }
    return true;
  }, []);

  const handleTelemetryChange = useCallback((enabled: boolean) => {
    telemetryToggleTouchedRef.current = true;
    setTelemetryEnabled(enabled);
  }, []);

  // Surface wizard step transitions so OnboardingFlow can record the
  // sub-step at abandonment time (the wizard's internal step is otherwise
  // invisible to the parent). Read via ref to keep the parent's callback
  // identity from triggering this effect.
  const onStepChangeRef = useRef(onStepChange);
  useEffect(() => {
    onStepChangeRef.current = onStepChange;
  });
  useEffect(() => {
    onStepChangeRef.current?.(state.step);
  }, [state.step]);

  const installedAgents = useMemo(
    () => AGENT_ORDER.filter((id) => isAgentLaunchable(state.availability[id])),
    [state.availability]
  );

  const selectedAgentIds = useMemo(
    () =>
      Object.entries(state.selections)
        .filter(([, sel]) => sel)
        .map(([id]) => id),
    [state.selections]
  );

  const flow = useMemo(() => flowSteps(isFirstRun), [isFirstRun]);
  const totalSteps = flow.length;
  const stepNumber = Math.max(0, flow.indexOf(state.step.type));

  const handleAppearanceContinue = useCallback(() => {
    directionRef.current = 1;
    dispatch({ type: "APPEARANCE_CONTINUE" });
  }, []);

  const handleAgentsContinue = useCallback(async () => {
    directionRef.current = 1;
    setIsSaving(true);
    try {
      for (const [agentId, pinned] of Object.entries(state.selections)) {
        await setAgentPinned(agentId, pinned);
      }
      dispatch({ type: "AGENTS_CONTINUE" });
    } finally {
      setIsSaving(false);
    }
  }, [state.selections, setAgentPinned]);

  const handlePrivacyContinue = useCallback(async () => {
    directionRef.current = 1;
    setIsSaving(true);
    try {
      await commitTelemetry(telemetryEnabled ? "errors" : "off");
      dispatch({ type: "PRIVACY_CONTINUE" });
    } finally {
      setIsSaving(false);
    }
  }, [commitTelemetry, telemetryEnabled]);

  const handleCliContinue = useCallback(() => {
    directionRef.current = 1;
    dispatch({ type: "CLI_CONTINUE" });
  }, []);

  const handlePermissionsContinue = useCallback(async () => {
    directionRef.current = 1;
    setIsSaving(true);
    try {
      // Always persist the explicit choice (on or off) so a pre-existing `true`
      // from an interrupted prior run can't override the default-off decision —
      // mirrors how telemetry commits even for the off state. Forward-fail: only
      // advance once the write resolves; on failure the store rolls back and
      // re-throws, so stay on the step for retry.
      await setGlobalSkipPermissions(permissionsEnabled);
      dispatch({ type: "PERMISSIONS_CONTINUE" });
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Skip-permissions wasn't saved. Try again.",
        // Explicit high priority so the failure surfaces a toast (the
        // permissions step itself is the retry surface, so no action button).
        priority: "high",
        context: { eventKind: "settings" },
      });
    } finally {
      setIsSaving(false);
    }
  }, [permissionsEnabled, setGlobalSkipPermissions]);

  const handleBack = useCallback(() => {
    directionRef.current = -1;
    dispatch({ type: "BACK" });
  }, []);

  const handleFinish = useCallback(() => {
    onClose();
  }, [onClose]);

  const notifyTelemetryDefault = useCallback(() => {
    notify({
      type: "info",
      title: "Crash reporting off by default",
      message: "Enable it anytime in Settings → Privacy & Data",
      priority: "low",
      countable: false,
    });
  }, []);

  const handleSkip = useCallback(async () => {
    // Mirror the Continue handlers' isSaving lock so a rapid double-click
    // can't race two commits and two close calls through `commitTelemetry`'s
    // ref guard before it flips.
    setIsSaving(true);
    try {
      let committedNow = false;
      if (isFirstRun) {
        committedNow = await commitTelemetry("off");
      }
      if (committedNow && !telemetryToggleTouchedRef.current) {
        notifyTelemetryDefault();
      }
      onClose();
    } finally {
      setIsSaving(false);
    }
  }, [onClose, isFirstRun, commitTelemetry, notifyTelemetryDefault]);

  const showLoadingSelections = !state.selectionsInitialized && isAvailabilityLoading;

  const handleBeforeClose = useCallback(async () => {
    // Any first-run close before the summary records telemetry off — silence is
    // not consent. Once the user reaches `complete` they have already passed the
    // privacy step, so their choice is committed and we must not re-commit.
    if (isFirstRun && state.step.type !== "complete") {
      const committedNow = await commitTelemetry("off");
      if (committedNow && !telemetryToggleTouchedRef.current) {
        notifyTelemetryDefault();
      }
    }
    return true;
  }, [isFirstRun, state.step.type, commitTelemetry, notifyTelemetryDefault]);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={handleFinish}
      onBeforeClose={isFirstRun ? handleBeforeClose : undefined}
      size="lg"
      dismissible={!isSaving}
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<Plug className="w-5 h-5 text-daintree-accent" />}>
          {isFirstRun && state.step.type === "appearance" ? "Welcome to Daintree" : "Agent Setup"}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <div className="relative overflow-hidden">
          <AnimatePresence mode="wait" custom={directionRef.current}>
            <m.div
              key={state.step.type}
              custom={directionRef.current}
              variants={prefersReducedMotion ? reducedStepVariants : stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {state.step.type === "appearance" && (
                <AppearanceStep
                  selectedSchemeId={selectedSchemeId}
                  onThemeSelect={handleThemeSelect}
                />
              )}
              {state.step.type === "agents" && (
                <AgentsStep
                  availability={state.availability}
                  selections={state.selections}
                  isLoading={showLoadingSelections}
                  isSaving={isSaving}
                  onToggle={(id, checked) =>
                    dispatch({ type: "TOGGLE_SELECTION", agentId: id, checked })
                  }
                  onFatalFailureChange={setHasFatalHealthFailure}
                  onCheckingChange={setIsHealthChecking}
                  isFirstRun={isFirstRun}
                />
              )}
              {state.step.type === "privacy" && (
                <PrivacyStep
                  telemetryEnabled={telemetryEnabled}
                  onTelemetryChange={handleTelemetryChange}
                />
              )}
              {state.step.type === "cli" && (
                <AgentCliStep
                  availability={state.availability}
                  selections={state.selections}
                  isFirstRun={isFirstRun}
                  onInstallComplete={() => {
                    void cliAvailabilityClient.refresh().then((result) => {
                      if (isOpenRef.current) {
                        dispatch({ type: "SET_AVAILABILITY", payload: result });
                      }
                    });
                  }}
                />
              )}
              {state.step.type === "permissions" && (
                <PermissionsStep
                  permissionsEnabled={permissionsEnabled}
                  onPermissionsChange={setPermissionsEnabled}
                />
              )}
              {state.step.type === "complete" && (
                <CompleteStep installedAgents={installedAgents} onClose={onClose} />
              )}
            </m.div>
          </AnimatePresence>
        </div>
      </AppDialog.Body>

      <AppDialog.Footer>
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-1.5">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                aria-current={i === stepNumber ? "step" : undefined}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  i === stepNumber
                    ? "bg-daintree-accent"
                    : i < stepNumber
                      ? "bg-daintree-accent/40"
                      : "bg-daintree-text/15"
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {state.step.type === "agents" &&
              !showLoadingSelections &&
              selectedAgentIds.length === 0 && (
                <span aria-live="polite" className="text-xs text-daintree-text/50">
                  Select at least one agent to continue
                </span>
              )}
            {state.step.type !== "complete" &&
              (state.history.length > 0 ? (
                <Button
                  variant="ghost"
                  onClick={handleBack}
                  className="text-daintree-text/70"
                  disabled={isSaving}
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={handleSkip}
                  disabled={isSaving}
                  className="text-daintree-text/60"
                >
                  Skip
                </Button>
              ))}
            {state.step.type === "appearance" && (
              <Button onClick={handleAppearanceContinue} disabled={isSaving}>
                Continue
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {state.step.type === "agents" && (
              <Button
                onClick={handleAgentsContinue}
                disabled={
                  selectedAgentIds.length === 0 ||
                  isSaving ||
                  hasFatalHealthFailure ||
                  isHealthChecking
                }
              >
                Continue
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {state.step.type === "privacy" && (
              <Button onClick={handlePrivacyContinue} disabled={isSaving}>
                Continue
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {state.step.type === "cli" && (
              <Button onClick={handleCliContinue}>
                Continue
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {state.step.type === "permissions" && (
              <Button onClick={handlePermissionsContinue} disabled={isSaving}>
                Continue
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {state.step.type === "complete" && <Button onClick={handleFinish}>Finish setup</Button>}
          </div>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}

// --- Appearance step (first-run theme picker) ---

function AppearanceStep({
  selectedSchemeId,
  onThemeSelect,
}: {
  selectedSchemeId?: string;
  onThemeSelect: (id: string) => void;
}) {
  const schemes = [daintreeScheme, bondiScheme] as const;

  return (
    <section>
      <h3 className="text-base font-semibold text-daintree-text mb-2">Appearance</h3>
      <p className="text-sm text-daintree-text/60 mb-4">Choose your preferred theme</p>
      <div className="grid grid-cols-2 gap-4" role="listbox" aria-label="Select theme">
        {schemes.map((scheme) => {
          const isSelected = selectedSchemeId === scheme.id;
          const isDark = scheme.type === "dark";
          return (
            <button
              key={scheme.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => onThemeSelect(scheme.id)}
              className={cn(
                "flex flex-col gap-2 p-3 rounded-[var(--radius-md)] border transition-colors text-left",
                isSelected
                  ? "border-border-strong bg-overlay-selected"
                  : "border-daintree-border bg-daintree-bg hover:border-daintree-text/30"
              )}
            >
              <ThemeMockup scheme={scheme} />
              <div className="flex items-center justify-between px-0.5">
                <div className="flex items-center gap-1.5">
                  {isDark ? (
                    <Moon className="w-3 h-3 text-daintree-text/50" />
                  ) : (
                    <Sun className="w-3 h-3 text-daintree-text/50" />
                  )}
                  <span className="text-sm font-medium text-daintree-text">{scheme.name}</span>
                  <span className="text-xs text-daintree-text/50">{isDark ? "Dark" : "Light"}</span>
                </div>
                {isSelected && <Check className="w-3.5 h-3.5 text-daintree-text shrink-0" />}
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-daintree-text/50 text-center mt-3">
        More themes available in Settings → Appearance
      </p>
    </section>
  );
}

// --- Agents step (system requirements + agent multi-select) ---

function AgentsStep({
  availability,
  selections,
  isLoading,
  isSaving,
  onToggle,
  onFatalFailureChange,
  onCheckingChange,
  isFirstRun = false,
}: {
  availability: CliAvailability;
  selections: Record<string, boolean>;
  isLoading: boolean;
  isSaving: boolean;
  onToggle: (agentId: string, checked: boolean) => void;
  onFatalFailureChange: (hasFatal: boolean) => void;
  onCheckingChange: (checking: boolean) => void;
  isFirstRun?: boolean;
}) {
  const featuredAgents = useMemo(
    () => sortTierByInstalled(FEATURED_AGENT_IDS, availability),
    [availability]
  );
  const moreAgents = useMemo(
    () => sortTierByInstalled(MORE_AGENT_IDS, availability),
    [availability]
  );

  return (
    <div className="space-y-6">
      <SystemRequirementsSection
        onFatalFailureChange={onFatalFailureChange}
        onCheckingChange={onCheckingChange}
      />

      <section>
        <h3 className="text-base font-semibold text-daintree-text mb-2">
          {isFirstRun ? "Agents" : "Choose your AI agents"}
        </h3>
        <p className="text-sm text-daintree-text/60 mb-4">
          Select the agents you want in your workflow. Already-installed agents are pre-selected.
          You can change this anytime from{" "}
          <span className="text-daintree-text/80">Settings → Agents</span>.
        </p>
        {isLoading ? (
          <Skeleton label="Loading agents" className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30"
              >
                <SkeletonBone className="w-4 h-4 shrink-0" />
                <SkeletonBone className="w-8 h-8 rounded-[var(--radius-sm)] shrink-0" />
                <div className="flex-1 min-w-0 space-y-1.5">
                  <SkeletonBone className="h-4 w-28" />
                  <SkeletonBone className="h-3 w-48" />
                </div>
                <SkeletonBone className="h-3 w-16 shrink-0" />
              </div>
            ))}
          </Skeleton>
        ) : (
          <div className="space-y-2">
            {featuredAgents.map((agentId) => (
              <AgentCard
                key={agentId}
                mode="onboarding"
                agentId={agentId}
                availability={availability}
                isChecked={selections[agentId] ?? false}
                isSaving={isSaving}
                onToggle={onToggle}
              />
            ))}

            {moreAgents.length > 0 && (
              <>
                <div className="flex items-center gap-2 py-1">
                  <div className="h-px flex-1 bg-border-divider" />
                  <span className="text-[11px] text-daintree-text/40 font-medium">More agents</span>
                  <div className="h-px flex-1 bg-border-divider" />
                </div>

                <div className="space-y-1.5">
                  {moreAgents.map((agentId) => (
                    <AgentCard
                      key={agentId}
                      mode="onboarding"
                      agentId={agentId}
                      availability={availability}
                      isChecked={selections[agentId] ?? false}
                      isSaving={isSaving}
                      onToggle={onToggle}
                      compact
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// --- Privacy step (first-run crash-reporting consent) ---

function PrivacyStep({
  telemetryEnabled,
  onTelemetryChange,
}: {
  telemetryEnabled?: boolean;
  onTelemetryChange: (enabled: boolean) => void;
}) {
  const crashReportingLabelId = useId();

  return (
    <section>
      <h3 className="text-base font-semibold text-daintree-text mb-2">Privacy</h3>
      <p className="text-sm text-daintree-text/60 mb-4">
        Help improve Daintree by sharing anonymous crash reports
      </p>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p id={crashReportingLabelId} className="text-sm font-medium text-daintree-text">
            Enable crash reporting
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={telemetryEnabled}
            aria-labelledby={crashReportingLabelId}
            onClick={() => onTelemetryChange(!telemetryEnabled)}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors",
              telemetryEnabled ? "bg-daintree-accent" : "bg-daintree-border"
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-4 w-4 rounded-full shadow transform transition-transform mt-0.5",
                telemetryEnabled
                  ? "translate-x-4 ml-0.5 bg-text-inverse"
                  : "translate-x-0 ml-0.5 bg-daintree-text"
              )}
            />
          </button>
        </div>
        <p className="text-xs text-daintree-text/50">
          No file contents or credentials are ever sent.
        </p>
        <button
          type="button"
          className="text-xs text-text-secondary hover:text-daintree-text underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:underline"
          onClick={() =>
            void actionService.dispatch(
              "telemetry.togglePreview",
              { active: true },
              { source: "user" }
            )
          }
        >
          Preview what would be sent
        </button>
      </div>
    </section>
  );
}

// --- Permissions step (first-run global skip-permissions consent) ---

function PermissionsStep({
  permissionsEnabled,
  onPermissionsChange,
}: {
  permissionsEnabled?: boolean;
  onPermissionsChange: (enabled: boolean) => void;
}) {
  const labelId = useId();
  const descriptionId = useId();

  return (
    <section>
      <h3 className="text-base font-semibold text-daintree-text mb-2">Agent permissions</h3>
      <p className="text-sm text-daintree-text/60 mb-4">
        Keep prompts on unless you trust agents to run commands and edit files without asking
      </p>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p id={labelId} className="text-sm font-medium text-daintree-text">
            Skip permission prompts for agents
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={permissionsEnabled}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            onClick={() => onPermissionsChange(!permissionsEnabled)}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors",
              permissionsEnabled ? "bg-daintree-accent" : "bg-daintree-border"
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-4 w-4 rounded-full shadow transform transition-transform mt-0.5",
                permissionsEnabled
                  ? "translate-x-4 ml-0.5 bg-text-inverse"
                  : "translate-x-0 ml-0.5 bg-daintree-text"
              )}
            />
          </button>
        </div>
        <p id={descriptionId} className="text-xs text-daintree-text/50">
          Agents act without confirmation — faster, but they run commands and edit files on their
          own. You can change this anytime in Settings → Agents.
        </p>
      </div>
    </section>
  );
}

// --- Complete step ---

export function CompleteStep({
  installedAgents,
  onClose,
}: {
  installedAgents: string[];
  onClose: () => void;
}) {
  const hasAgents = installedAgents.length > 0;

  const handleLaunch = useCallback(() => {
    void actionService.dispatch("panel.palette", undefined, { source: "user" });
    onClose();
  }, [onClose]);

  return (
    <div className="space-y-6 text-center py-4">
      <div>
        <div className="w-12 h-12 rounded-full bg-status-success/15 flex items-center justify-center mx-auto mb-4">
          <Sparkles className="w-6 h-6 text-status-success" />
        </div>
        <h3 className="text-base font-semibold text-daintree-text mb-2">Setup complete</h3>
        <p className="text-sm text-daintree-text/60">
          {hasAgents
            ? `You have ${installedAgents.length} agent${installedAgents.length === 1 ? "" : "s"} ready to use. Launch them from the toolbar or with keyboard shortcuts.`
            : "No agents were installed. You can install them later from Settings → Agents."}
        </p>
      </div>

      {hasAgents && (
        <div className="space-y-2">
          {installedAgents.map((id) => {
            const agent = AGENT_REGISTRY[id];
            if (!agent) return null;
            const Icon = agent.icon;
            const presetCount = agent.presets?.length ?? 0;
            const shortcut = keybindingService.getDisplayCombo(`agent.${id}`);

            return (
              <div
                key={id}
                data-testid={`agent-card-${id}`}
                className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border border-status-success/20 bg-status-success/5"
              >
                <BrandMark brandColor={agent.color}>
                  <Icon size={18} />
                </BrandMark>
                <span className="text-sm text-daintree-text font-medium">{agent.name}</span>
                {presetCount > 1 && (
                  <span
                    data-testid="preset-count-badge"
                    className="text-[10px] text-status-info font-medium bg-status-info/10 px-1.5 py-0.5 rounded"
                  >
                    {presetCount} presets
                  </span>
                )}
                {shortcut && (
                  <span className="text-[11px] text-daintree-text/40 ml-auto">{shortcut}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {hasAgents && (
        <div className="flex justify-center">
          <Button onClick={handleLaunch} data-testid="complete-step-launch-agent">
            <Sparkles className="w-4 h-4 mr-1" />
            Launch an agent
          </Button>
        </div>
      )}

      <p className="text-xs text-daintree-text/40">
        You can re-run this wizard from Settings → Agents
      </p>
    </div>
  );
}
