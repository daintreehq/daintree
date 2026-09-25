import { useState, type ComponentType, type CSSProperties } from "react";
import { ChevronRight } from "lucide-react";
import { BrandMark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentAvailabilityState } from "@shared/types";
import { SettingsSection } from "./SettingsSection";
import { SettingsEmptyRow, SettingsGroup } from "./SettingsGroup";
import { getAgentHealth } from "./agentHealth";

export interface InventoryAgent {
  id: string;
  name: string;
  color: string;
  Icon: ComponentType<{ size?: number; style?: CSSProperties; className?: string }>;
}

interface AgentInventorySectionProps {
  agents: InventoryAgent[];
  availability: Partial<Record<string, AgentAvailabilityState>> | null;
  isLoading: boolean;
  error: string | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  onOpenAgent: (id: string) => void;
  onRunSetupWizard: () => void;
}

const ROW = cn(
  "settings-list-item group flex w-full items-center gap-3 px-4 py-2.5 text-left",
  "cursor-pointer transition-colors",
  "hover:bg-[var(--settings-nav-hover-bg,var(--theme-overlay-hover))]",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
);

/**
 * Every supported agent and whether it is usable on this machine — the first thing on
 * the page, because a missing or blocked agent is why most people open it.
 *
 * Agents needing attention always show. The ready ones and the ones that aren't
 * installed are inventory the summary already counts, so each sits behind its own
 * disclosure rather than filling the first screen.
 */
export function AgentInventorySection({
  agents,
  availability,
  isLoading,
  error,
  isRefreshing,
  onRefresh,
  onOpenAgent,
  onRunSetupWizard,
}: AgentInventorySectionProps) {
  const [showReady, setShowReady] = useState(false);
  const [showMissing, setShowMissing] = useState(false);

  const known = availability !== null && Object.keys(availability).length > 0;
  const withHealth = agents.map((agent) => ({
    agent,
    health: getAgentHealth(availability?.[agent.id]),
  }));
  const attention = withHealth.filter((a) => a.health.kind === "attention");
  const ready = withHealth.filter((a) => a.health.kind === "ready");
  // Only a confirmed "missing" counts as not installed. An agent the probe didn't
  // report on (the built-in assistant, which isn't a CLI) is left out of the inventory
  // rather than counted as something it isn't.
  const missing = withHealth.filter((a) => a.health.kind === "missing");
  const installed = attention.length + ready.length;

  const summary = !known
    ? isLoading
      ? "Checking which agents are installed on this machine"
      : "Which agents are installed on this machine"
    : installed === 0
      ? "No agent CLIs found on this machine"
      : attention.length === 0
        ? `${installed} installed and ready to use`
        : `${ready.length} of ${installed} installed agents ready — ${attention.length} need${attention.length === 1 ? "s" : ""} attention`;

  const wizardButton = (
    <Button size="sm" variant="outline" onClick={onRunSetupWizard}>
      Run setup wizard
    </Button>
  );

  const renderRow = (agent: InventoryAgent) => {
    const health = getAgentHealth(availability?.[agent.id]);
    const statusLabel =
      health.kind === "attention" || health.kind === "missing" ? health.label : null;
    return (
      <li key={agent.id}>
        <button
          type="button"
          className={ROW}
          data-inventory-agent={agent.id}
          aria-label={`${agent.name}${statusLabel ? ` — ${statusLabel}` : ""}. Open settings`}
          onClick={() => onOpenAgent(agent.id)}
        >
          <BrandMark brandColor={agent.color} className="shrink-0">
            <agent.Icon size={16} />
          </BrandMark>
          <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{agent.name}</span>
          {statusLabel && (
            <span
              className="flex shrink-0 items-center gap-1.5"
              data-agent-status={statusLabel}
              aria-hidden="true"
            >
              {health.kind === "attention" && (
                <health.Icon className="h-3.5 w-3.5 text-status-warning" />
              )}
              <span className="text-xs text-text-secondary">{statusLabel}</span>
            </span>
          )}
          <ChevronRight
            className="h-4 w-4 shrink-0 text-text-secondary transition-colors group-hover:text-text-primary group-focus-visible:text-text-primary"
            aria-hidden="true"
          />
        </button>
      </li>
    );
  };

  const disclosure = (
    id: string,
    open: boolean,
    toggle: () => void,
    closedLabel: string,
    list: typeof withHealth
  ) => (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        className={ROW}
      >
        <ChevronRight
          data-animated-chevron
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform duration-150 group-hover:text-text-primary",
            open ? "rotate-90" : "rotate-0"
          )}
          aria-hidden="true"
        />
        <span className="flex-1 text-sm text-text-secondary transition-colors group-hover:text-text-primary">
          {closedLabel}
        </span>
      </button>
      <div id={id}>
        {open && (
          <ul className="divide-y divide-border-subtle border-t border-border-subtle">
            {list.map(({ agent }) => renderRow(agent))}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <SettingsSection
      id="agents-inventory"
      title="Agents"
      description={<span role="status">{summary}</span>}
      action={
        <>
          {known && installed > 0 && wizardButton}
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={isRefreshing}>
            {isRefreshing ? "Checking…" : "Re-check"}
          </Button>
        </>
      }
    >
      {error ? (
        <SettingsGroup>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <p role="alert" className="text-xs text-text-secondary">
              Couldn&apos;t check which agents are installed.
            </p>
            <Button size="sm" variant="outline" onClick={onRefresh} disabled={isRefreshing}>
              Retry
            </Button>
          </div>
        </SettingsGroup>
      ) : known ? (
        <SettingsGroup>
          {installed === 0 && (
            <SettingsEmptyRow action={wizardButton}>
              Install an agent CLI and Daintree picks it up — the setup wizard walks you through it
            </SettingsEmptyRow>
          )}
          {attention.length > 0 && (
            <ul className="divide-y divide-border-subtle">
              {attention.map(({ agent }) => renderRow(agent))}
            </ul>
          )}
          {ready.length > 0 &&
            disclosure(
              "agents-inventory-ready",
              showReady,
              () => setShowReady((v) => !v),
              showReady
                ? "Hide ready agents"
                : `Show ${ready.length} ready ${ready.length === 1 ? "agent" : "agents"}`,
              ready
            )}
          {missing.length > 0 &&
            disclosure(
              "agents-inventory-missing",
              showMissing,
              () => setShowMissing((v) => !v),
              showMissing
                ? "Hide agents that aren't installed"
                : `Show ${missing.length} ${missing.length === 1 ? "agent" : "agents"} that ${missing.length === 1 ? "isn't" : "aren't"} installed`,
              missing
            )}
        </SettingsGroup>
      ) : null}
    </SettingsSection>
  );
}
