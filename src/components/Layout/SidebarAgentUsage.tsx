import { useEffect, useId, useState } from "react";
import { ChevronRight, Gauge } from "lucide-react";
import type { AgentUsageReadout } from "@shared/types/ipc/agentUsage";
import {
  agentUsageShownUntil,
  isAgentUsagePastAttention,
  tightestAgentUsage,
} from "@shared/utils/agentUsage";
import {
  setAgentUsageExpanded,
  useAgentUsageExpanded,
} from "@/components/Layout/agentUsageExpanded";
import { SidebarFooterGlyph } from "@/components/Layout/SidebarFooterGlyph";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { getAgentConfig } from "@/config/agents";
import { useAgentUsageReadouts } from "@/hooks/useAgentUsageReadouts";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { describeAgentUsage } from "@/utils/agentUsageFormat";

const WarningGlyph = SEVERITY_GLYPH.warning;

const RESET_WAKE_HORIZON_MS = 60_000;

const OPEN_QUOTA = "Open account quota";

const ROW_CLASS = cn(
  "flex min-h-7 w-full min-w-0 items-center gap-2 py-1 pl-4 pr-3 text-left",
  "transition-colors hover:bg-overlay-soft",
  "focus-visible:bg-overlay-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
);

// The hosts group's header, so the two disclosures in the footer read as one family.
const HEADER_CLASS = cn(
  "group/toggle flex min-h-7 w-full min-w-0 shrink-0 items-center gap-2 px-4 text-left",
  "transition-colors hover:bg-overlay-subtle",
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selection-outline"
);

/**
 * The tightest usage window of each agent's accounts with an agent running
 * now on the machine this window shows (#17318): one dense row per agent that
 * has a reading there under a "Usage" header that folds them away, nothing
 * when none does. Another machine's reading never stands in or competes,
 * whatever its login is called, since each host may run its agents on a
 * different account (#17979). A row turns to the warning tone past the fixed
 * threshold, or when Claude Code itself said the limit is near or reached,
 * and opens that machine's account quota section; folded, the header takes
 * the same tone for any of them, without the figures. Open or folded is the
 * machine's, shared by every window and kept across restarts.
 */
export function SidebarAgentUsage() {
  const readouts = useAgentUsageReadouts();
  const now = useResetAwareClock(readouts, useGlobalMinuteClock());
  const expanded = useAgentUsageExpanded();
  const listId = useId();
  const warningId = useId();
  const shown = tightestAgentUsage(readouts, (readout) => readout.reading, now);
  if (shown.length === 0) return null;
  const warning = !expanded && shown.some((readout) => isAgentUsagePastAttention(readout.reading));
  return (
    <div data-sidebar-agent-usage="" className="flex w-full shrink-0 flex-col">
      <button
        type="button"
        data-sidebar-agent-usage-toggle=""
        data-attention={warning ? "" : undefined}
        aria-label="Usage"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-describedby={warning ? warningId : undefined}
        onClick={() => setAgentUsageExpanded(!expanded)}
        className={HEADER_CLASS}
      >
        <SidebarFooterGlyph>
          <ChevronRight
            data-animated-chevron
            className={cn(
              "size-3 text-text-secondary transition-transform duration-150 ease-out",
              expanded && "rotate-90"
            )}
            aria-hidden="true"
          />
        </SidebarFooterGlyph>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-2xs font-medium select-none",
            warning
              ? "text-text-primary"
              : "text-text-secondary group-hover/toggle:text-text-primary"
          )}
        >
          Usage
        </span>
        {warning && (
          <>
            {/* The toggle's name stays "Usage" folded or open (the label pins it); the warning describes it. */}
            <span id={warningId} className="sr-only">
              An agent is near or at its usage limit
            </span>
            <WarningGlyph className="size-3 shrink-0 text-status-warning" aria-hidden="true" />
          </>
        )}
      </button>
      {/* Always in the tree, so the header's aria-controls names it open or folded. */}
      <div id={listId} hidden={!expanded} className="flex flex-col">
        {expanded &&
          shown.map((readout) => (
            // By agent alone, so a line that moves to another login keeps its focus.
            <AgentUsageRow key={readout.reading.agentId} readout={readout} now={now} />
          ))}
      </div>
    </div>
  );
}

/**
 * The minute clock, moved on as a reading resets or ages out as well: the next
 * reading takes over then, not up to a minute later. An end further off than
 * the next minute is that minute's to catch.
 */
function useResetAwareClock(readouts: readonly AgentUsageReadout[], minute: number): number {
  const [atReset, setAtReset] = useState(0);
  const now = Math.max(minute, atReset);
  const next = Math.min(
    ...readouts.flatMap(({ reading }) => {
      const until = agentUsageShownUntil(reading);
      return until > now ? [until] : [];
    })
  );
  useEffect(() => {
    const wait = next - now;
    if (!Number.isFinite(wait) || wait > RESET_WAKE_HORIZON_MS) return;
    const timer = setTimeout(() => setAtReset(next), wait + 1);
    return () => clearTimeout(timer);
  }, [next, now]);
  return now;
}

function AgentUsageRow({ readout, now }: { readout: AgentUsageReadout; now: number }) {
  const { agentId } = readout.reading;
  const config = getAgentConfig(agentId);
  const agentName = config?.name ?? agentId;
  const AgentIcon = config?.icon ?? Gauge;
  const line = describeAgentUsage(readout, agentName, now);
  const label = [line.text, ...line.detail, OPEN_QUOTA].filter(Boolean).join(". ");

  return (
    // Forced on: the detail carries the login, machine and age the row leaves
    // out, which a keyboard user needs as much as a pointer does.
    <TruncatedTooltip
      content={
        <span className="flex flex-col gap-0.5">
          {[agentName, ...line.detail, OPEN_QUOTA].map((text) => (
            <span key={text}>{text}</span>
          ))}
        </span>
      }
      isTruncated
      side="top"
      contentClassName="max-w-xs"
    >
      <button
        type="button"
        data-sidebar-agent-usage-row={agentId}
        data-attention={line.attention ? "" : undefined}
        aria-label={label}
        className={ROW_CLASS}
        onClick={() =>
          void actionService.dispatch(
            "app.settings.openTab",
            { tab: "agents", subtab: agentId, sectionId: "agents-account-quota" },
            { source: "user" }
          )
        }
      >
        <SidebarFooterGlyph>
          <AgentIcon
            size={12}
            className={line.attention ? "text-status-warning" : "text-text-secondary"}
            aria-hidden="true"
          />
        </SidebarFooterGlyph>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-2xs font-medium tabular-nums",
            line.attention ? "text-text-primary" : "text-text-secondary"
          )}
        >
          {line.row}
        </span>
      </button>
    </TruncatedTooltip>
  );
}
