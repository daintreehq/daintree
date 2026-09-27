import type { ComponentType, CSSProperties } from "react";
import { Settings2, ShieldOff } from "lucide-react";
import { BrandMark } from "@/components/icons";
import type { AgentAvailabilityState } from "@shared/types";
import { getAgentHealth } from "./agentHealth";
import { SettingsSubjectPicker } from "./SettingsSubjectPicker";

export interface AgentOption {
  id: string;
  name: string;
  color: string;
  Icon: ComponentType<{ size?: number; style?: CSSProperties; className?: string }>;
  selected: boolean;
  availability: AgentAvailabilityState | undefined;
  dangerousEnabled: boolean;
  hasCustomFlags: boolean;
}

interface AgentSelectorDropdownProps {
  agentOptions: AgentOption[];
  activeSubtab: string;
  onSubtabChange: (id: string) => void;
}

type PickerItem = { kind: "general"; id: typeof GENERAL_ID } | (AgentOption & { kind: "agent" });

const GENERAL_ID = "general";
const GENERAL_ITEM: PickerItem = { kind: "general", id: GENERAL_ID };

export function AgentSelectorDropdown({
  agentOptions,
  activeSubtab,
  onSubtabChange,
}: AgentSelectorDropdownProps) {
  const entries: PickerItem[] = agentOptions.map((agent) => ({ ...agent, kind: "agent" }));
  const selectedAgent =
    activeSubtab !== GENERAL_ID ? agentOptions.find((a) => a.id === activeSubtab) : null;

  return (
    <SettingsSubjectPicker<PickerItem>
      idPrefix="agent-selector"
      overview={GENERAL_ITEM}
      entries={entries}
      matches={(item, q) => item.kind === "agent" && item.name.toLowerCase().includes(q)}
      activeId={selectedAgent ? selectedAgent.id : GENERAL_ID}
      onChange={onSubtabChange}
      listLabel="Agents"
      filterLabel="Filter agents"
      placeholder="Filter agents…"
      noMatches={(q) => <>No agents match &ldquo;{q}&rdquo;</>}
      current={
        selectedAgent ? (
          <>
            <BrandMark brandColor={selectedAgent.color} className="shrink-0">
              <selectedAgent.Icon size={18} />
            </BrandMark>
            <span className="min-w-0 truncate text-base font-semibold">{selectedAgent.name}</span>
            <AgentStatusMarks agent={selectedAgent} />
          </>
        ) : (
          <>
            <Settings2 size={18} className="shrink-0 text-text-secondary" aria-hidden="true" />
            <span className="min-w-0 truncate text-base font-semibold">General</span>
          </>
        )
      }
      renderRow={(item) =>
        item.kind === "general" ? (
          <>
            <Settings2 size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="truncate">General</div>
              <div className="text-xs text-text-secondary truncate">Global settings</div>
            </div>
          </>
        ) : (
          <>
            <BrandMark brandColor={item.color} className="shrink-0">
              <item.Icon size={16} />
            </BrandMark>
            <span className="flex-1 min-w-0 truncate">{item.name}</span>
            <AgentStatusMarks agent={item} />
          </>
        )
      }
    />
  );
}

/**
 * What the picker says about an agent without opening it: whether it is usable on this
 * machine, and whether it skips permission prompts. Each is a glyph and words rather
 * than a coloured dot — a dot alone could not tell "not installed" from "blocked", and
 * said nothing at all to anyone who can't see its colour. Ready agents show nothing.
 */
function AgentStatusMarks({ agent }: { agent: AgentOption }) {
  const health = getAgentHealth(agent.availability);
  const statusLabel =
    health.kind === "attention" || health.kind === "missing" ? health.label : null;
  if (!statusLabel && !agent.dangerousEnabled) return null;
  return (
    <span className="flex shrink-0 items-center gap-3 font-normal">
      {agent.dangerousEnabled && (
        <span className="flex items-center gap-1.5">
          <ShieldOff className="h-3.5 w-3.5 text-status-error" aria-hidden="true" />
          <span className="text-xs text-text-secondary">Skips permission prompts</span>
        </span>
      )}
      {statusLabel && (
        <span className="flex items-center gap-1.5" data-agent-status={statusLabel}>
          {health.kind === "attention" && (
            <health.Icon className="h-3.5 w-3.5 text-status-warning" aria-hidden="true" />
          )}
          <span className="text-xs text-text-secondary">{statusLabel}</span>
        </span>
      )}
    </span>
  );
}
