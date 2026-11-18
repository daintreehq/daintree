import { useEffect, useState } from "react";
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
import { describeAgentUsage, THIS_MACHINE } from "@/utils/agentUsageFormat";

const RESET_WAKE_HORIZON_MS = 60_000;

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
 * shows. A reading from another machine has no section here, and its line
 * says which window has it.
 */
export function SidebarAgentUsage() {
  const readouts = useAgentUsageReadouts();
  const now = useResetAwareClock(readouts, useGlobalMinuteClock());
  const shown = tightestAgentUsage(readouts, (readout) => readout.reading, now);
  if (shown.length === 0) return null;
  return (
    <div data-sidebar-agent-usage="" className="flex w-full shrink-0 flex-col">
      {shown.map((readout) => (
        // By agent alone, so a line that moves to another machine keeps its focus.
        <AgentUsageRow key={readout.reading.agentId} readout={readout} now={now} />
      ))}
    </div>
  );
}

/**
 * The minute clock, moved on at a shown reading's reset as well: the next
 * reading takes over then, not up to a minute later. A reset further off than
 * the next minute is that minute's to catch.
 */
function useResetAwareClock(readouts: readonly AgentUsageReadout[], minute: number): number {
  const [atReset, setAtReset] = useState(0);
  const now = Math.max(minute, atReset);
  const next = Math.min(
    ...readouts.flatMap(({ reading }) =>
      reading.resetsAt !== null && reading.resetsAt > now ? [reading.resetsAt] : []
    )
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
  const agentName = getAgentConfig(agentId)?.name ?? agentId;
  const opensHere = readout.hostId === currentHostId();
  const machine = readout.hostName ?? (opensHere ? null : THIS_MACHINE);
  const line = describeAgentUsage(readout, agentName, now, machine);
  const where = opensHere
    ? "Open account quota"
    : `Its account quota shows in a window on ${machine === THIS_MACHINE ? "this machine" : machine}`;
  const label = [line.text, line.age, ...line.detail, where].filter(Boolean).join(". ");
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
          "min-w-0 flex-1 truncate text-2xs font-medium",
          line.attention ? "text-text-primary" : "text-text-secondary"
        )}
      >
        {line.text}
      </span>
      {line.age !== null && (
        <span className="shrink-0 text-2xs tabular-nums text-text-secondary">{line.age}</span>
      )}
    </>
  );
  const attributes = {
    "data-sidebar-agent-usage-row": agentId,
    "data-attention": line.attention ? "" : undefined,
  };

  return (
    // Forced on: the detail carries the login, machine and age, which a
    // keyboard user needs as much as a pointer does.
    <TruncatedTooltip
      content={
        <span className="flex flex-col gap-0.5">
          {[...line.detail, where].map((text) => (
            <span key={text}>{text}</span>
          ))}
        </span>
      }
      isTruncated
      side="top"
      contentClassName="max-w-xs"
    >
      {opensHere ? (
        <button
          type="button"
          {...attributes}
          aria-label={label}
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
        <div {...attributes} role="group" aria-label={label} className={ROW_CLASS}>
          {content}
        </div>
      )}
    </TruncatedTooltip>
  );
}
