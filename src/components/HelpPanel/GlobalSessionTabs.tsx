import { FactSeparator } from "@/components/ui/FactSeparator";
import { UnderlineTabs, type UnderlineTabItem } from "@/components/ui/UnderlineTabs";
import { getAgentConfig } from "@/config/agents";
import {
  GLOBAL_ASSISTANT_SLOT,
  globalAssistantSessionNumber,
  isGlobalAssistantSlot,
  type GlobalAssistantSlot,
} from "@shared/config/globalAssistantSessions";
import type { GlobalAssistantView } from "@shared/types/ipc/help";
import { TabAgentMark } from "./HelpSessionTabs";

/** The panel every tab here controls: the global pane's body below the strip. */
export function globalSessionPanelId(idBase: string): string {
  return `${idBase}-global-session-panel`;
}

export function globalSessionTabId(idBase: string, slot: GlobalAssistantSlot | string): string {
  return `${idBase}-global-session-${slot}`;
}

/**
 * Which of the machine's global assistant sessions the pane shows (#18142).
 * Each is named by its number, which every window shares, then its agent. The
 * first session is always offered, running or not; the second only while it
 * exists or is the one on screen. With both open, the one that coordinates
 * says so (#18143); choosing a tab only chooses what is shown.
 */
export function GlobalSessionTabs({
  idBase,
  sessions,
  shownSlot,
  onSelect,
}: {
  /** Shared with the panel below, which names the tab it shows. */
  idBase: string;
  sessions: readonly GlobalAssistantView[];
  shownSlot: GlobalAssistantSlot;
  onSelect: (slot: GlobalAssistantSlot) => void;
}) {
  const both = sessions.filter((session) => session.occupied).length > 1;
  const tabs: UnderlineTabItem[] = sessions
    .filter(
      (session) =>
        session.slot === GLOBAL_ASSISTANT_SLOT || session.occupied || session.slot === shownSlot
    )
    .map((session) => {
      const agentId = session.agentId;
      const coordinates = both && session.coordinating;
      return {
        id: String(session.slot),
        label: `Session ${globalAssistantSessionNumber(session.slot)}`,
        ...(agentId ? { renderIcon: () => <TabAgentMark agentId={agentId} /> } : {}),
        ...(agentId || coordinates
          ? {
              trailing: (
                <span className="text-xs font-normal text-text-secondary">
                  {agentId ? (getAgentConfig(agentId)?.name ?? agentId) : null}
                  {coordinates && (
                    <span data-testid={`help-global-coordinating-${session.slot}`}>
                      {agentId && (
                        <>
                          {" "}
                          <FactSeparator />{" "}
                        </>
                      )}
                      Coordinating
                    </span>
                  )}
                </span>
              ),
            }
          : {}),
      };
    });

  return (
    <div
      className="flex h-8 min-w-0 shrink-0 items-stretch overflow-x-auto border-b border-border-default px-1.5"
      data-testid="help-global-session-tabs"
    >
      <UnderlineTabs
        tabs={tabs}
        activeId={String(shownSlot)}
        onChange={(id) => {
          const slot = Number(id);
          if (isGlobalAssistantSlot(slot)) onSelect(slot);
        }}
        aria-label="Global assistant sessions"
        tabId={(id) => globalSessionTabId(idBase, id)}
        panelId={() => globalSessionPanelId(idBase)}
        density="strip"
      />
    </div>
  );
}
