import type { ComponentType, ReactNode } from "react";
import { SquareTerminal } from "lucide-react";
import { BrandMark } from "@/components/icons/BrandMark";
import { getAgentConfig } from "@/config/agents";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

const CEILING_SENTENCE = `${pluralize(MAX_ASSISTANT_SLOTS, "session")} is the maximum for one project`;

/**
 * One row of the menus that start a session on a chosen agent (#13442): the
 * agent's mark in the menu's icon gutter, then "New session with <agent>".
 *
 * `parked` dims the label alone, for a row whose item stays at full opacity so
 * the reason beside it reads at the menu's own contrast.
 */
export function NewSessionWithAgentLabel({
  agentId,
  parked = false,
}: {
  agentId: string;
  parked?: boolean;
}) {
  const config = getAgentConfig(agentId);
  const Icon = config?.icon ?? SquareTerminal;
  return (
    <span className={cn("flex items-center", parked && "opacity-50")}>
      <span
        data-menu-icon
        aria-hidden="true"
        className="mr-2 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
      >
        <BrandMark brandColor={config?.color}>
          <Icon className="h-3.5 w-3.5" />
        </BrandMark>
      </span>
      New session with {config?.name ?? agentId}
    </span>
  );
}

/**
 * Why a "New session" row is parked at the session ceiling (#16659), for every
 * menu that offers one. A disabled item can't carry a tooltip, so the reason
 * sits on the row: the count in the menu's trailing slot when `meta` is given,
 * and the limit in words in the row's accessible name, since that slot is
 * hidden from assistive tech.
 */
export function SessionCeilingReason({
  open,
  meta: Meta,
}: {
  open: number;
  meta?: ComponentType<{ children?: ReactNode }>;
}) {
  return (
    <>
      {Meta && <Meta>{`${open} of ${MAX_ASSISTANT_SLOTS} open`}</Meta>}
      <span className="sr-only">, {CEILING_SENTENCE}</span>
    </>
  );
}

/**
 * Said once as a menu with parked "New session" rows opens. The menu's arrow keys
 * skip a disabled row, so a reason carried only in its name never reaches someone
 * moving through the menu with a screen reader.
 */
export function announceSessionCeiling(): void {
  useAnnouncerStore.getState().announce(`New session unavailable, ${CEILING_SENTENCE}`, "polite");
}
