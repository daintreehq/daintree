import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { SystemToolsStep } from "./SystemToolsStep";
import { AgentCliStep } from "./AgentCliStep";
import { AGENT_REGISTRY } from "@/config/agents";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { useAgentSettingsStore } from "@/store";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { cliAvailabilityClient } from "@/clients";
import { isCanopyEnvEnabled } from "@/utils/env";
import type { CliAvailability } from "@shared/types";
import { Sparkles, ChevronLeft, ChevronRight, ArrowRight } from "lucide-react";
import { CanopyAgentIcon } from "@/components/icons";

const AGENT_ORDER = BUILT_IN_AGENT_IDS;
const POLL_INTERVAL = 3000;
const TOTAL_STEPS = 3;

const SKIP_FIRST_RUN_DIALOGS = isCanopyEnvEnabled("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS");

// --- Wizard state machine ---

type WizardStep = { type: "system-tools" } | { type: "agent-cli" } | { type: "complete" };

interface WizardState {
  step: WizardStep;
  history: WizardStep[];
  availability: CliAvailability;
  selections: Record<string, boolean>;
  selectionsInitialized: boolean;
}

type WizardAction =
  | { type: "SYSTEM_TOOLS_CONTINUE" }
  | { type: "AGENT_CLI_CONTINUE" }
  | { type: "BACK" }
  | { type: "SET_AVAILABILITY"; payload: CliAvailability }
  | { type: "INIT_SELECTIONS"; payload: Record<string, boolean> }
  | { type: "TOGGLE_SELECTION"; agentId: string; checked: boolean }
  | { type: "RESET"; availability: CliAvailability };

function buildInitialState(availability: CliAvailability, skipHealth: boolean): WizardState {
  return {
    step: skipHealth ? { type: "agent-cli" } : { type: "system-tools" },
    history: [],
    availability,
    selections: {},
    selectionsInitialized: false,
  };
}

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "SYSTEM_TOOLS_CONTINUE":
      return {
        ...state,
        step: { type: "agent-cli" },
        history: [...state.history, state.step],
      };

    case "AGENT_CLI_CONTINUE":
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
      return buildInitialState(action.availability, SKIP_FIRST_RUN_DIALOGS);

    default:
      return state;
  }
}

// --- Component ---

interface AgentSetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  initialAvailability?: CliAvailability;
}

export function AgentSetupWizard({ isOpen, onClose, initialAvailability }: AgentSetupWizardProps) {
  const [state, dispatch] = useReducer(
    wizardReducer,
    initialAvailability ?? ({} as CliAvailability),
    (avail) => buildInitialState(avail, SKIP_FIRST_RUN_DIALOGS)
  );

  const { setAgentSelected } = useAgentSettingsStore();
  const isAvailabilityLoading = useCliAvailabilityStore((s) => s.isLoading || s.isRefreshing);
  const [isSaving, setIsSaving] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isOpenRef = useRef(isOpen);
  const initRef = useRef(false);

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
      });
      initRef.current = false;
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, initialAvailability]);

  // Poll availability
  useEffect(() => {
    if (!isOpen) return;

    const poll = () => {
      cliAvailabilityClient
        .refresh()
        .then((result) => {
          if (isOpenRef.current) {
            dispatch({ type: "SET_AVAILABILITY", payload: result });
          }
        })
        .catch(console.error);
    };

    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [isOpen]);

  // Initialize selections once when availability is ready
  useEffect(() => {
    if (!isOpen || initRef.current || state.selectionsInitialized) return;
    if (isAvailabilityLoading) return;

    initRef.current = true;
    const initial: Record<string, boolean> = {};
    for (const agentId of AGENT_ORDER) {
      initial[agentId] = state.availability[agentId] === true;
    }
    dispatch({ type: "INIT_SELECTIONS", payload: initial });
  }, [isOpen, isAvailabilityLoading, state.availability, state.selectionsInitialized]);

  const installedAgents = useMemo(
    () => AGENT_ORDER.filter((id) => state.availability[id] === true),
    [state.availability]
  );

  const selectedAgentIds = useMemo(
    () =>
      Object.entries(state.selections)
        .filter(([, sel]) => sel)
        .map(([id]) => id),
    [state.selections]
  );

  const stepNumber = (() => {
    switch (state.step.type) {
      case "system-tools":
        return 0;
      case "agent-cli":
        return 1;
      case "complete":
        return 2;
    }
  })();

  const handleSystemToolsContinue = useCallback(() => {
    dispatch({ type: "SYSTEM_TOOLS_CONTINUE" });
  }, []);

  const handleAgentCliContinue = useCallback(async () => {
    setIsSaving(true);
    try {
      for (const [agentId, selected] of Object.entries(state.selections)) {
        await setAgentSelected(agentId, selected);
      }
      dispatch({ type: "AGENT_CLI_CONTINUE" });
    } finally {
      setIsSaving(false);
    }
  }, [state.selections, setAgentSelected]);

  const handleBack = useCallback(() => {
    dispatch({ type: "BACK" });
  }, []);

  const handleFinish = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleSelectionSkip = useCallback(() => {
    onClose();
  }, [onClose]);

  const showLoadingSelections = !state.selectionsInitialized && isAvailabilityLoading;

  return (
    <AppDialog isOpen={isOpen} onClose={handleFinish} size="lg" dismissible={!isSaving}>
      <AppDialog.Header>
        <AppDialog.Title icon={<CanopyAgentIcon className="w-5 h-5 text-canopy-accent" />}>
          Agent Setup
        </AppDialog.Title>
        <div className="flex items-center gap-3">
          <span className="text-xs text-canopy-text/40">
            {stepNumber + 1} of {TOTAL_STEPS}
          </span>
          <AppDialog.CloseButton />
        </div>
      </AppDialog.Header>

      <AppDialog.Body>
        {state.step.type === "system-tools" && (
          <SystemToolsStep onSkip={handleSystemToolsContinue} />
        )}
        {state.step.type === "agent-cli" && (
          <AgentCliStep
            availability={state.availability}
            selections={state.selections}
            isLoading={showLoadingSelections}
            isSaving={isSaving}
            onToggle={(id, checked) => dispatch({ type: "TOGGLE_SELECTION", agentId: id, checked })}
          />
        )}
        {state.step.type === "complete" && <CompleteStep installedAgents={installedAgents} />}
      </AppDialog.Body>

      <AppDialog.Footer>
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-1.5">
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
              <div
                key={i}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  i === stepNumber
                    ? "bg-canopy-accent"
                    : i < stepNumber
                      ? "bg-canopy-accent/40"
                      : "bg-canopy-text/15"
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {state.step.type === "agent-cli" && (
              <Button
                variant="ghost"
                onClick={handleBack}
                className="text-canopy-text/70"
                disabled={isSaving}
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </Button>
            )}
            {state.step.type === "system-tools" && (
              <Button onClick={handleSystemToolsContinue}>
                Continue
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {state.step.type === "agent-cli" && (
              <>
                <Button
                  variant="ghost"
                  onClick={handleSelectionSkip}
                  disabled={isSaving}
                  className="text-canopy-text/60"
                >
                  Skip
                </Button>
                <Button
                  onClick={handleAgentCliContinue}
                  disabled={selectedAgentIds.length === 0 || isSaving}
                >
                  Continue
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </>
            )}
            {state.step.type === "complete" && <Button onClick={handleFinish}>Finish Setup</Button>}
          </div>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}

// --- Complete step ---

function CompleteStep({ installedAgents }: { installedAgents: string[] }) {
  return (
    <div className="space-y-6 text-center py-4">
      <div>
        <div className="w-12 h-12 rounded-full bg-status-success/15 flex items-center justify-center mx-auto mb-4">
          <Sparkles className="w-6 h-6 text-status-success" />
        </div>
        <h3 className="text-base font-semibold text-canopy-text mb-2">Setup Complete</h3>
        <p className="text-sm text-canopy-text/60">
          {installedAgents.length > 0
            ? `You have ${installedAgents.length} agent${installedAgents.length === 1 ? "" : "s"} ready to use. Launch them from the toolbar or with keyboard shortcuts.`
            : "No agents were installed. You can install them later from Settings > Agents."}
        </p>
      </div>

      {installedAgents.length > 0 && (
        <div className="space-y-2">
          {installedAgents.map((id) => {
            const agent = AGENT_REGISTRY[id];
            if (!agent) return null;
            const Icon = agent.icon;

            return (
              <div
                key={id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border border-status-success/20 bg-status-success/5"
              >
                <Icon size={18} brandColor={agent.color} />
                <span className="text-sm text-canopy-text font-medium">{agent.name}</span>
                {agent.shortcut && (
                  <span className="text-[11px] text-canopy-text/40 ml-auto">{agent.shortcut}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-canopy-text/40">
        You can re-run this wizard from Settings &gt; Agents
      </p>
    </div>
  );
}
