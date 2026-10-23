import { useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import { assistantTerminalApi } from "@/services/assistantSubject";
import { assistantBand, canopyAssistantDomId } from "./openAssistantItem";
import { CanopyTerminal } from "./CanopyTerminal";
import {
  assistantCoverageNote,
  assistantNoticeSummary,
  assistantStatus,
  type CanopyAssistantItem,
} from "./canopyAssistants";

/**
 * One Daintree Assistant in the list. Its role leads, the agent it runs on
 * follows, and where it runs — project and session, or global — tells two
 * apart. No archive, trash or rename: those are a worker's.
 */
export function CanopyAssistantRow({
  item,
  isSelected,
  tabbable,
  onSelect,
  onOpen,
  onKeyDown,
}: {
  item: CanopyAssistantItem;
  isSelected: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const domId = canopyAssistantDomId(item.id);
  const status = assistantStatus(item);
  const name = ["Daintree Assistant", item.scopeLabel].join(", ");
  const supervision = [assistantNoticeSummary(item.notices), assistantCoverageNote(item)]
    .filter((part): part is string => !!part)
    .join(" · ");
  const meta = [
    status,
    item.agentName,
    item.label,
    item.attached ? null : "no window here",
    supervision || null,
  ]
    .filter((part): part is string => !!part)
    .join(", ");
  return (
    <div
      id={domId}
      role="option"
      aria-selected={isSelected}
      aria-label={name}
      aria-describedby={`${domId}-meta`}
      tabIndex={tabbable ? 0 : -1}
      data-canopy-assistant=""
      data-ask={item.ask ?? undefined}
      onFocus={() => {
        if (!isSelected) onSelect();
      }}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={onKeyDown}
      className="canopy-inbox-row group/row relative flex w-full shrink-0 cursor-pointer items-stretch gap-3 px-3 py-2.5 text-left"
    >
      <span id={`${domId}-meta`} className="sr-only">
        {meta}
      </span>
      <span aria-hidden="true" className="flex w-16 shrink-0 flex-col gap-1">
        <span className="flex h-5 items-center gap-2">
          <span className="flex size-4 items-center justify-center">
            <PilotRunState band={assistantBand(item)} agentState={item.agentState ?? undefined} />
          </span>
          <span className="flex size-4 items-center justify-center">
            <DaintreeIcon size={16} />
          </span>
        </span>
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 truncate text-sm leading-5 text-text-primary">
          {item.scopeLabel}
        </span>
        <span
          className={cn(
            "min-w-0 truncate text-xs leading-4",
            // An ask stays in full ink; an assistant at its prompt steps down.
            item.ask ? "text-text-primary" : "text-text-secondary"
          )}
        >
          {status}
        </span>
        <span className="min-w-0 truncate text-xs leading-4 text-text-secondary">
          {["Daintree Assistant", item.agentName, item.attached ? null : "No window here"]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {supervision && (
          <span
            data-canopy-assistant-supervision=""
            className="min-w-0 truncate text-xs leading-4 text-text-secondary"
          >
            {supervision}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The selected assistant's own live session, through the exact-subject viewer,
 * and the way into its lane. Nothing it shows is read by Canopy's readers.
 */
export function CanopyAssistantPane({
  item,
  refusal,
  onOpen,
}: {
  item: CanopyAssistantItem;
  /** Why the last "Open in Assistant" didn't, in words. */
  refusal: string | null;
  onOpen: () => void;
}) {
  // Made once per pane: the pane is keyed by the exact subject, and a fresh
  // directory read hands over an equal subject that must not reopen the stream.
  const [api] = useState(() => assistantTerminalApi(item.subject));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="canopy-assistant-pane">
      <div className="flex h-9 min-w-0 shrink-0 items-center gap-2 px-1 text-xs select-none">
        <span className="min-w-0 shrink-0 font-medium text-text-primary">Daintree Assistant</span>
        <span className="min-w-0 flex-1 truncate text-text-secondary">
          {[item.scopeLabel, item.agentName].filter(Boolean).join(" · ")}
        </span>
        {/* The global session has no panel in a project view to land in. */}
        {item.subject.scope.kind === "project" && (
          <Button variant="outline" size="xs" onClick={onOpen}>
            Open in Assistant
          </Button>
        )}
      </div>
      {item.ask === "confirm" && item.confirmation && (
        <div className="shrink-0 pb-2" data-canopy-assistant-confirmation="">
          <Callout severity="warning" size="compact" title="Waiting on your confirmation">
            {confirmationRoute(item)}
          </Callout>
        </div>
      )}
      {refusal !== null && (
        <div className="shrink-0 pb-2">
          <Callout severity="warning" size="compact" title="Couldn't open this assistant">
            {refusal}
          </Callout>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-md)] border border-border-default bg-surface-panel">
        {/* The viewer is admitted by the exact subject, not by a spawn stamp:
            the incarnation only says which run this pane is for. */}
        <CanopyTerminal
          runId={item.subject.terminalId}
          spawnedAt={item.subject.incarnation}
          api={api}
        />
      </div>
    </div>
  );
}

/**
 * Where the confirmation is answered: in the dialog its session raised, and
 * nowhere else. Canopy only says where that is; it can't answer one.
 */
function confirmationRoute(item: CanopyAssistantItem): string {
  const action = item.confirmation?.actionId ?? "an action";
  if (item.subject.hostId !== LOCAL_HOST_ID) {
    return `Its call to ${action} waits on a dialog on the host it runs on. Answer it there.`;
  }
  if (item.subject.scope.kind === "global") {
    return `Its call to ${action} waits on a dialog in the window the global assistant runs in. Answer it there.`;
  }
  if (!item.attached) {
    return `Its call to ${action} waits on a dialog, but no window shows this assistant. It fails unanswered when it times out.`;
  }
  return `Its call to ${action} waits on a dialog in its project's window. Open in Assistant to answer it there.`;
}
