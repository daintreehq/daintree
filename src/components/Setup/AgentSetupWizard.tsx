import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { AgentSetupStep } from "./AgentSetupStep";
import { EmbeddedTerminal } from "./EmbeddedTerminal";
import { SystemHealthCheckStep } from "./SystemHealthCheckStep";
import { AGENT_REGISTRY, getAgentConfig } from "@/config/agents";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { cliAvailabilityClient } from "@/clients";
import { isCanopyEnvEnabled } from "@/utils/env";
import type { CliAvailability } from "@shared/types";
import {
  Sparkles,
  ChevronLeft,
  ChevronRight,
  ArrowRight,
  SkipForward,
  PackagePlus,
} from "lucide-react";

const AGENT_ORDER = BUILT_IN_AGENT_IDS;
const POLL_INTERVAL = 3000;

const SKIP_FIRST_RUN_DIALOGS = isCanopyEnvEnabled("CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS");

interface AgentSetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  initialAvailability?: CliAvailability;
  agentIds?: readonly string[];
}

type WizardStep = "health" | "welcome" | "agent" | "complete";

export function AgentSetupWizard({
  isOpen,
  onClose,
  initialAvailability,
  agentIds,
}: AgentSetupWizardProps) {
  const effectiveAgentOrder = useMemo(() => {
    if (!agentIds || agentIds.length === 0) return AGENT_ORDER;
    const filtered = AGENT_ORDER.filter((id) => agentIds.includes(id));
    return filtered.length > 0 ? filtered : AGENT_ORDER;
  }, [agentIds]);

  const [step, setStep] = useState<WizardStep>(SKIP_FIRST_RUN_DIALOGS ? "welcome" : "health");
  const [agentIndex, setAgentIndex] = useState(0);
  const [availability, setAvailability] = useState<CliAvailability>(
    initialAvailability ?? ({} as CliAvailability)
  );
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isOpenRef = useRef(isOpen);
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  const currentAgentId = effectiveAgentOrder[agentIndex];
  const currentAgent = useMemo(
    () => (currentAgentId ? getAgentConfig(currentAgentId) : undefined),
    [currentAgentId]
  );
  const isCurrentAvailable = currentAgentId ? availability[currentAgentId] === true : false;

  const installedAgents = useMemo(
    () => effectiveAgentOrder.filter((id) => availability[id] === true),
    [effectiveAgentOrder, availability]
  );

  // Reset wizard state when reopened
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      setStep(SKIP_FIRST_RUN_DIALOGS ? "welcome" : "health");
      setAgentIndex(0);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const poll = () => {
      cliAvailabilityClient
        .refresh()
        .then((result) => {
          if (isOpenRef.current) setAvailability(result);
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

  const handleNext = useCallback(() => {
    if (step === "health") {
      setStep("welcome");
    } else if (step === "welcome") {
      setStep("agent");
      setAgentIndex(0);
    } else if (step === "agent") {
      if (agentIndex < effectiveAgentOrder.length - 1) {
        setAgentIndex((i) => i + 1);
      } else {
        setStep("complete");
      }
    }
  }, [step, agentIndex, effectiveAgentOrder]);

  const handleBack = useCallback(() => {
    if (step === "welcome") {
      setStep("health");
    } else if (step === "agent") {
      if (agentIndex > 0) {
        setAgentIndex((i) => i - 1);
      } else {
        setStep("welcome");
      }
    } else if (step === "complete") {
      setStep("agent");
      setAgentIndex(effectiveAgentOrder.length - 1);
    }
  }, [step, agentIndex, effectiveAgentOrder]);

  const handleSkip = useCallback(() => {
    handleNext();
  }, [handleNext]);

  const handleFinish = useCallback(() => {
    onClose();
  }, [onClose]);

  const stepNumber =
    step === "health"
      ? 0
      : step === "welcome"
        ? 1
        : step === "agent"
          ? agentIndex + 2
          : effectiveAgentOrder.length + 2;
  const totalSteps = effectiveAgentOrder.length + 3;

  return (
    <AppDialog isOpen={isOpen} onClose={handleFinish} size="lg" dismissible={true}>
      <AppDialog.Header>
        <AppDialog.Title icon={<PackagePlus className="w-5 h-5 text-canopy-accent" />}>
          Agent Setup
        </AppDialog.Title>
        <div className="flex items-center gap-3">
          <span className="text-xs text-canopy-text/40">
            {stepNumber + 1} of {totalSteps}
          </span>
          <AppDialog.CloseButton />
        </div>
      </AppDialog.Header>

      <AppDialog.Body>
        {step === "health" && (
          <SystemHealthCheckStep onSkip={handleNext} agentIds={effectiveAgentOrder} />
        )}
        {step === "welcome" && (
          <WelcomeStep availability={availability} agentOrder={effectiveAgentOrder} />
        )}
        {step === "agent" && currentAgent && (
          <div className="space-y-5">
            <AgentSetupStep
              agent={currentAgent}
              isAvailable={isCurrentAvailable}
              icon={currentAgent.icon}
            />
            <div className="border-t border-canopy-border pt-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="text-xs font-medium text-canopy-text/60">Terminal</div>
                <div className="text-[11px] text-canopy-text/30">
                  Run installation commands here
                </div>
              </div>
              <EmbeddedTerminal />
            </div>
          </div>
        )}
        {step === "complete" && <CompleteStep installedAgents={installedAgents} />}
      </AppDialog.Body>

      <AppDialog.Footer>
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-1.5">
            {Array.from({ length: totalSteps }).map((_, i) => (
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
            {step !== "health" && (
              <Button variant="ghost" onClick={handleBack} className="text-canopy-text/70">
                <ChevronLeft className="w-4 h-4" />
                Back
              </Button>
            )}
            {step === "health" && (
              <Button onClick={handleNext}>
                Continue
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {step === "welcome" && (
              <Button onClick={handleNext}>
                Get Started
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {step === "agent" && !isCurrentAvailable && (
              <Button variant="ghost" onClick={handleSkip} className="text-canopy-text/60">
                <SkipForward className="w-4 h-4" />
                Skip
              </Button>
            )}
            {step === "agent" && (
              <Button onClick={handleNext}>
                {isCurrentAvailable ? "Continue" : "Next"}
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {step === "complete" && <Button onClick={handleFinish}>Finish Setup</Button>}
          </div>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}

function WelcomeStep({
  availability,
  agentOrder,
}: {
  availability: CliAvailability;
  agentOrder: readonly string[];
}) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-canopy-text mb-2">
          Get started with AI agents
        </h3>
        <p className="text-sm text-canopy-text/60">
          Canopy orchestrates multiple AI coding agents. This wizard will help you install the CLI
          tools you need. Each agent is optional — install the ones you want to use.
        </p>
      </div>

      <div className="space-y-2">
        {agentOrder.map((id) => {
          const agent = AGENT_REGISTRY[id];
          if (!agent) return null;
          const isInstalled = availability[id] === true;
          const Icon = agent.icon;

          return (
            <div
              key={id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30"
            >
              <div
                className="w-8 h-8 rounded-[var(--radius-sm)] flex items-center justify-center"
                style={{ backgroundColor: `${agent.color}15` }}
              >
                <Icon size={18} brandColor={agent.color} />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-canopy-text">{agent.name}</div>
                {agent.tooltip && (
                  <div className="text-[11px] text-canopy-text/40">{agent.tooltip}</div>
                )}
              </div>
              {isInstalled ? (
                <span className="text-[11px] text-status-success font-medium">Installed</span>
              ) : (
                <span className="text-[11px] text-canopy-text/30">Not installed</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
