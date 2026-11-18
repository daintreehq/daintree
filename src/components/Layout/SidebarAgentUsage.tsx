import { Gauge } from "lucide-react";
import { getAgentConfig } from "@shared/config/agentRegistry";
import type { AgentUsageReadout } from "@shared/types/ipc/agentUsage";
import { tightestAgentUsage } from "@shared/utils/agentUsage";
import { SidebarFooterGlyph } from "@/components/Layout/SidebarFooterGlyph";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { useAgentUsageReadouts } from "@/hooks/useAgentUsageReadouts";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import { currentHostId } from "@/hooks/useHostPlatform";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { describeAgentUsage } from "@/utils/agentUsageFormat";

const ROW_CLASS = "flex min-h-7 w-full min-w-0 items-center gap-2 py-1 pl-4 pr-3 text-left";

const BUTTON_CLASS = cn(
  ROW_CLASS,
  "transition-colors hover:bg-overlay-soft",
  "focus-visible:bg-overlay-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
);

/**
 * The tightest usage window of each agent's accounts with an agent running
 * now, on this machine or a linked host (#17318): one quiet line per agent
 * that has a reading, nothing when none does. It turns to the warning tone
 * past the fixed threshold, or when Claude Code itself said the limit is near
 * or reached, and opens the account quota section on the machine the window
 * shows. A reading from another machine has no section here to open.
 */
export function SidebarAgentUsage() {
  const readouts = useAgentUsageReadouts();
  const now = useGlobalMinuteClock();
  const shown = tightestAgentUsage(readouts, (readout) => readout.reading, now);
  if (shown.length === 0) return null;
  return (
    <div data-sidebar-agent-usage="" className="flex w-full shrink-0 flex-col">
      {shown.map((readout) => (
        <AgentUsageRow
          key={`${readout.reading.agentId}:${readout.hostId}`}
          readout={readout}
          now={now}
        />
      ))}
    </div>
  );
}

function AgentUsageRow({ readout, now }: { readout: AgentUsageReadout; now: number }) {
  const { agentId } = readout.reading;
  const agentName = getAgentConfig(agentId)?.name ?? agentId;
  const line = describeAgentUsage(readout, agentName, now);
  const opensHere = readout.hostId === currentHostId();
  const content = (
    <>
      <SidebarFooterGlyph>
        <Gauge
          className={cn("h-3 w-3", line.attention ? "text-status-warning" : "text-text-secondary")}
          aria-hidden="true"
        />
      </SidebarFooterGlyph>
      <span
        className={cn(
          "min-w-0 truncate text-2xs font-medium",
          line.attention ? "text-text-primary" : "text-text-secondary"
        )}
      >
        {line.text}
      </span>
    </>
  );
  const detail = (
    <span className="flex flex-col gap-0.5">
      {line.detail.map((text) => (
        <span key={text}>{text}</span>
      ))}
    </span>
  );

  return (
    // Forced on: the detail carries the login, machine and age, which a
    // keyboard user needs as much as a pointer does.
    <TruncatedTooltip content={detail} isTruncated side="top" contentClassName="max-w-xs">
      {opensHere ? (
        <button
          type="button"
          data-sidebar-agent-usage-row={agentId}
          data-attention={line.attention ? "" : undefined}
          aria-label={`${line.text}. ${line.detail.join(". ")}. Open account quota`}
          className={BUTTON_CLASS}
          onClick={() =>
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "agents", subtab: agentId, sectionId: "agents-account-quota" },
              { source: "user" }
            )
          }
        >
          {content}
        </button>
      ) : (
        <div
          data-sidebar-agent-usage-row={agentId}
          data-attention={line.attention ? "" : undefined}
          className={ROW_CLASS}
        >
          {content}
        </div>
      )}
    </TruncatedTooltip>
  );
}
