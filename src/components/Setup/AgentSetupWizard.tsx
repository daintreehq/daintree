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
import { Sparkles, ChevronLeft, ArrowRight, Check, Sun, Moon } from "lucide-react";
import { AnimatePresence, m, useReducedMotion, type Variants } from "framer-motion";
import { Plug } from "@/components/icons";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  EASE_OUT_EXPO_FM,
  UI_EXIT_EASING_FM,
} from "@/lib/animationUtils";
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

// Directional but subordinate to the content: a fixed short offset rather than
// a percentage of the panel, which on the tallest step travelled ~200px and
// read as the whole dialog swapping rather than the step advancing.
const STEP_SLIDE_PX = 24;

const stepVariants: Variants = {
  initial: (direction: number) => ({
    x: direction * STEP_SLIDE_PX,
    opacity: 0,
  }),
  animate: {
    x: 0,
    opacity: 1,
    transition: { duration: UI_ENTER_DURATION / 1000, ease: EASE_OUT_EXPO_FM },
  },
  exit: (direction: number) => ({
    x: direction * -STEP_SLIDE_PX,
    opacity: 0,
    transition: { duration: UI_EXIT_DURATION / 1000, ease: UI_EXIT_EASING_FM },
  }),
};

// Reduced motion drops the travel and keeps the cross-fade on the palette tier.
const reducedStepVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: UI_PALETTE_ENTER_DURATION / 1000 } },
  exit: { opacity: 0, transition: { duration: UI_PALETTE_EXIT_DURATION / 1000 } },
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
// have those toggles in Settings). This is the MAXIMUM flow; `visibleFlowSteps`
// narrows it to the route a given run actually takes, which is what the
// "Step n of n" display counts.
export function flowSteps(isFirstRun: boolean): WizardStep["type"][] {
  return isFirstRun
    ? ["appearance", "agents", "privacy", "cli", "permissions", "complete"]
    : ["agents", "cli", "complete"];
}

/**
 * The wizard's step names, owned by the shell so every step gets the same top
 * edge, type scale and spacing instead of each step component rolling its own.
 */
export const STEP_META: Record<WizardStep["type"], { title: string; subtitle: string }> = {
  appearance: {
    title: "Appearance",
    subtitle: "Choose your preferred theme",
  },
  agents: {
    title: "Choose your AI agents",
    subtitle:
      "Already-installed agents are pre-selected. You can change this anytime from Settings → Agents.",
  },
  privacy: {
    title: "Privacy",
    subtitle: "Help improve Daintree by sharing anonymous crash reports",
  },
  cli: {
    title: "Install agents",
    subtitle: "Install the agents you picked that aren't on your machine yet",
  },
  permissions: {
    title: "Agent permissions",
    subtitle:
      "Keep prompts on unless you trust agents to run commands and edit files without asking",
  },
  complete: {
    title: "Setup complete",
    subtitle: "",
  },
};

/**
 * True when the `cli` step has nothing to do. The reducer branches on this to
 * skip the step, and the progress display filters the step out for the same
 * reason — they call the same predicate so the count can never disagree with
 * the route the user is actually walked through.
 */
export function allSelectedAgentsInstalled(state: WizardState): boolean {
  const selectedIds = Object.keys(state.selections).filter((id) => state.selections[id]);
  return (
    selectedIds.length > 0 && selectedIds.every((id) => isAgentLaunchable(state.availability[id]))
  );
}

/**
 * The steps this particular run will actually show. `flowSteps` is the maximum
 * flow; when every selected agent is already installed the `cli` step never
 * renders, and counting it would make the numbering skip (a user went
 * "step 3 of 6" straight to "step 5 of 6") and overstate what is left.
 *
 * The denominator must never shift retroactively, so once the run is past the
 * point where `cli` would have appeared the answer is read from `history` — the
 * route actually taken — and not from availability. Availability keeps moving
 * underneath us (the wizard re-probes every 3s, and an install completing would
 * otherwise silently drop a step the user already walked through). Only while
 * the user is still upstream of `cli` does the count track their selections,
 * which is a step they are actively editing, and only the total moves — the
 * number of steps already behind them never does.
 */
export function visibleFlowSteps(state: WizardState): WizardStep["type"][] {
  const flow = flowSteps(state.isFirstRun);
  const withoutCli = flow.filter((step) => step !== "cli");

  if (state.step.type === "cli" || state.history.some((step) => step.type === "cli")) {
    return flow;
  }

  const cliIndex = flow.indexOf("cli");
  const currentIndex = flow.indexOf(state.step.type);
  if (cliIndex !== -1 && currentIndex > cliIndex) {
    // Downstream of `cli` and it is not in history: it was definitively skipped.
    return withoutCli;
  }

  return allSelectedAgentsInstalled(state) ? withoutCli : flow;
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
  if (allSelectedAgentsInstalled(state)) {
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
  const [isInstalling, setIsInstalling] = useState(false);

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

  // AppDialog's default `initialFocus="first"` lands on the header Close button
  // — the one control that discards a first-run setup (and commits crash
  // reporting off on the way out) if the user presses Enter. Take focus
  // ourselves and put it on the step heading instead, which is also what the
  // ARIA practices ask for on a step advance: land on the heading with
  // tabindex=-1 so the step's name and instructions are read before the first
  // control, rather than leaving focus on the button that was just pressed.
  //
  // This has to be a ref callback rather than an effect on `state.step.type`.
  // `AnimatePresence mode="wait"` holds the OUTGOING step mounted while it
  // animates out and only then mounts the incoming one, so an effect keyed on
  // the step would focus the heading that is about to be removed — and focus
  // would land back on the document when it unmounted. The callback fires when
  // the incoming heading actually attaches, whenever that is.
  const focusStepHeading = useCallback((node: HTMLHeadingElement | null) => {
    if (node && isOpenRef.current) node.focus();
  }, []);

  // Same featured-then-more ordering the agents step presents, so the summary
  // lists them in the order the user just saw rather than registry order.
  const installedAgents = useMemo(
    () =>
      [
        ...sortTierByInstalled(FEATURED_AGENT_IDS, state.availability),
        ...sortTierByInstalled(MORE_AGENT_IDS, state.availability),
      ].filter((id) => isAgentLaunchable(state.availability[id])),
    [state.availability]
  );

  const selectedAgentIds = useMemo(
    () =>
      Object.entries(state.selections)
        .filter(([, sel]) => sel)
        .map(([id]) => id),
    [state.selections]
  );

  const flow = useMemo(() => visibleFlowSteps(state), [state]);
  const totalSteps = flow.length;
  const stepNumber = Math.max(0, flow.indexOf(state.step.type));
  const stepMeta = STEP_META[state.step.type];

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

  // Moved out of CompleteStep so the completion screen has one primary action
  // in the footer rather than a second filled button in the body. The behaviour
  // is unchanged: open the launcher palette, then close the wizard.
  const handleLaunchAgent = useCallback(() => {
    void actionService.dispatch("panel.palette", undefined, { source: "user" });
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

  const showLoadingSelections = !state.selectionsInitialized;
  const hasInstalledAgents = installedAgents.length > 0;

  // Rides AppDialog's own hint slot (bottom-left), which is where the progress
  // dots used to sit and where every other dialog puts footer context.
  const footerHint =
    state.step.type === "agents" && !showLoadingSelections && selectedAgentIds.length === 0 ? (
      <span aria-live="polite">Select at least one agent to continue</span>
    ) : undefined;

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
      dismissible={!isSaving && !isInstalling}
      initialFocus="none"
      data-testid="agent-setup-wizard"
    >
      <AppDialog.Header>
        <div className="flex items-center gap-3 min-w-0">
          {/* Neutral, not accent: the header glyph is decoration, and the
              footer's primary action is this dialog's one load-bearing signal. */}
          <AppDialog.Title icon={<Plug className="w-5 h-5 text-text-secondary" />}>
            {isFirstRun ? "Set up Daintree" : "Agent setup"}
          </AppDialog.Title>
          <span
            className="text-sm tabular-nums text-text-secondary shrink-0"
            data-testid="agent-setup-step-count"
          >
            Step {stepNumber + 1} of {totalSteps}
          </span>
        </div>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {/* A floor under the sparsest steps so the panel stops halving in height
            between consent gates and the agent list; AppDialog's max-h still
            caps the tall end and owns the scrolling. */}
        <div className="relative overflow-hidden min-h-[22rem]">
          <AnimatePresence mode="wait" custom={directionRef.current}>
            <m.div
              key={state.step.type}
              data-testid="agent-setup-step"
              data-step={state.step.type}
              custom={directionRef.current}
              variants={prefersReducedMotion ? reducedStepVariants : stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {/* Owned by the shell, not the step: identical top edge, type
                  scale and spacing on every step, and the persistent frame
                  names the current task rather than leaving it to body copy. */}
              <div className="mb-4">
                <h3
                  ref={focusStepHeading}
                  tabIndex={-1}
                  className="text-base font-semibold text-daintree-text outline-hidden focus-visible:outline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-daintree-accent rounded-xs"
                >
                  {stepMeta.title}
                </h3>
                {stepMeta.subtitle && (
                  <p className="text-sm text-text-secondary mt-1">{stepMeta.subtitle}</p>
                )}
              </div>
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
                  onBusyChange={setIsInstalling}
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
              {state.step.type === "complete" && <CompleteStep installedAgents={installedAgents} />}
            </m.div>
          </AnimatePresence>
        </div>
      </AppDialog.Body>

      {/* The dialog's own accessible name stays pinned to the persistent header
          title; the step change is announced here instead, so a screen reader
          hears which step opened without the dialog appearing to be replaced. */}
      <span className="sr-only" aria-live="polite">
        {`Step ${stepNumber + 1} of ${totalSteps}: ${stepMeta.title}`}
      </span>

      <AppDialog.Footer hint={footerHint}>
        <div className="flex items-center gap-3 ml-auto">
          {state.step.type !== "complete" &&
            (state.history.length > 0 ? (
              <Button
                variant="ghost"
                onClick={handleBack}
                className="text-daintree-text/70 hover:text-daintree-text"
                disabled={isSaving || isInstalling}
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </Button>
            ) : (
              // Not "Skip": this closes the whole wizard, it does not skip the
              // step. "Not now" is the app's existing word for deferring an
              // app-initiated setup — the welcome banner that opens this very
              // wizard uses it. "Cancel" on a re-run, where the selection the
              // user just made is discarded rather than deferred.
              <Button
                variant="ghost"
                onClick={handleSkip}
                disabled={isSaving}
                data-testid="agent-setup-exit"
                className="text-daintree-text/70 hover:text-daintree-text"
              >
                {isFirstRun ? "Not now" : "Cancel"}
              </Button>
            ))}
          {state.step.type === "appearance" && (
            <Button variant="contrast" onClick={handleAppearanceContinue} disabled={isSaving}>
              Continue
              <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          )}
          {state.step.type === "agents" && (
            <Button
              variant="contrast"
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
            <Button variant="contrast" onClick={handlePrivacyContinue} disabled={isSaving}>
              Continue
              <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          )}
          {state.step.type === "cli" && (
            <Button variant="contrast" onClick={handleCliContinue} disabled={isInstalling}>
              Continue
              <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          )}
          {state.step.type === "permissions" && (
            <Button variant="contrast" onClick={handlePermissionsContinue} disabled={isSaving}>
              Continue
              <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          )}
          {/* Completion resolves to the forward move, matching CloneRepoDialog's
              "Open Project" and GitInitDialog's "Continue" — the wizard's last
              screen should start the work, not merely dismiss itself. With no
              agents installed there is nothing to launch, so finishing is the
              only action and it takes the primary slot. */}
          {state.step.type === "complete" &&
            (hasInstalledAgents ? (
              <Button
                variant="contrast"
                onClick={handleLaunchAgent}
                data-testid="complete-step-launch-agent"
              >
                <Sparkles className="w-4 h-4 mr-1" />
                Launch an agent
              </Button>
            ) : (
              <Button variant="contrast" onClick={handleFinish}>
                Finish setup
              </Button>
            ))}
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
                // Without this the cards fell through to the browser's default
                // focus ring, which is the OS accent colour and ignores the
                // theme and forced-colors entirely.
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent",
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
}: {
  availability: CliAvailability;
  selections: Record<string, boolean>;
  isLoading: boolean;
  isSaving: boolean;
  onToggle: (agentId: string, checked: boolean) => void;
  onFatalFailureChange: (hasFatal: boolean) => void;
  onCheckingChange: (checking: boolean) => void;
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
      <div className="space-y-3 rounded-[var(--radius-lg)] border border-daintree-border p-4">
        <div className="flex items-center justify-between gap-3">
          <p id={crashReportingLabelId} className="text-sm font-medium text-daintree-text">
            Enable crash reporting
          </p>
          <SettingsSwitch
            checked={telemetryEnabled ?? false}
            onCheckedChange={onTelemetryChange}
            aria-labelledby={crashReportingLabelId}
          />
        </div>
        <p className="text-xs text-text-secondary">
          No file contents or credentials are ever sent.
        </p>
        {/* Underlined at rest: previously this read as a third line of body
            copy and only became identifiable as a control on hover. */}
        <button
          type="button"
          className="text-xs text-text-link underline underline-offset-2 hover:text-daintree-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent rounded-xs"
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
      <div className="space-y-3 rounded-[var(--radius-lg)] border border-daintree-border p-4">
        <div className="flex items-center justify-between gap-3">
          <p id={labelId} className="text-sm font-medium text-daintree-text">
            Skip permission prompts for agents
          </p>
          <SettingsSwitch
            checked={permissionsEnabled ?? false}
            onCheckedChange={onPermissionsChange}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
          />
        </div>
        <p id={descriptionId} className="text-xs text-text-secondary">
          Agents act without confirmation — faster, but they run commands and edit files on their
          own. You can change this anytime in Settings → Agents.
        </p>
      </div>
    </section>
  );
}

// --- Complete step ---

export function CompleteStep({ installedAgents }: { installedAgents: string[] }) {
  const hasAgents = installedAgents.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Sparkles className="w-5 h-5 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-sm text-text-secondary">
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
                  <span className="text-[11px] text-text-muted ml-auto tabular-nums">
                    {shortcut}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-text-muted">You can re-run this wizard from Settings → Agents</p>
    </div>
  );
}
