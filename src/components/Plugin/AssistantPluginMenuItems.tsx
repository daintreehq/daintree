import { useEffect, useMemo, useState } from "react";
import {
  DropdownMenuItem,
  DropdownMenuMeta,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { PluginContextMenuSection } from "@/components/Plugin/PluginContextMenuSection";
import { usePluginContextMenuItems } from "@/hooks/usePluginContextMenuItems";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";

/**
 * The assistant session a plugin `assistant` item was opened on, as its action
 * receives it. `slot` and `incarnation` are numbers, which a `when` clause has no
 * type for, so they reach the action and an availability check only.
 */
export type AssistantPluginMenuSubject =
  | {
      assistantScope: "project";
      /** The project, or scratch workspace, whose Assistant panel holds the lane. */
      projectId: string;
      /** The lane's zero-based slot, stable across relaunches of that lane. */
      slot: number;
      /** Absent while the lane's terminal isn't up: paused, or still launching. */
      terminalId?: string;
      agentId?: string;
    }
  | {
      assistantScope: "global";
      terminalId: string;
      /** Which launch of that terminal: a restarted run keeps its terminal id. */
      incarnation: number;
      agentId?: string;
    };

const SECTION_COMPONENTS = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Meta: DropdownMenuMeta,
};

/**
 * Whether `current` is still the session the menu opened on: the same lane with
 * the same terminal, or the same launch of the global run. A terminal binding
 * into a lane that had none counts as a change, since a paused conversation and a
 * fresh launch into its slot look alike until then.
 */
function isSameSession(
  opened: AssistantPluginMenuSubject | null,
  current: AssistantPluginMenuSubject
): boolean {
  if (opened === null) return false;
  if (opened.assistantScope === "global") {
    return (
      current.assistantScope === "global" &&
      opened.terminalId === current.terminalId &&
      opened.incarnation === current.incarnation
    );
  }
  if (current.assistantScope !== "project") return false;
  return (
    opened.projectId === current.projectId &&
    opened.slot === current.slot &&
    opened.terminalId === current.terminalId
  );
}

/**
 * Plugin `assistant` context-menu items for an Assistant panel menu (#18138), as
 * a trailing section with its own leading separator.
 *
 * Mount it unconditionally inside the menu's content, passing `null` while there
 * is no session to offer: it then lives exactly as long as one opening, and the
 * session it mounts with is the one the menu opened on. If that lane or run is
 * replaced while the menu is open, the rows go until the menu is opened again,
 * so a pick never lands on a successor the person didn't choose; a menu opened
 * with no session offers none for the rest of that opening. Built-in rows are
 * unaffected.
 *
 * With no plugin contributing an `assistant` item this renders nothing and
 * subscribes to nothing beyond the shared item store.
 */
export function AssistantPluginMenuItems({
  subject,
}: {
  subject: AssistantPluginMenuSubject | null;
}) {
  const init = usePluginContextMenuItemsStore((s) => s.init);
  const hasAssistantItems = usePluginContextMenuItemsStore((s) =>
    s.entries.some((entry) => entry.item.location === "assistant")
  );
  const [openedOn] = useState(subject);

  useEffect(() => {
    init();
  }, [init]);

  if (!hasAssistantItems || subject === null || !isSameSession(openedOn, subject)) return null;
  return <AssistantPluginMenuRows subject={subject} />;
}

function AssistantPluginMenuRows({ subject }: { subject: AssistantPluginMenuSubject }) {
  const { assistantScope, terminalId, agentId } = subject;
  const projectId = subject.assistantScope === "project" ? subject.projectId : undefined;
  const slot = subject.assistantScope === "project" ? subject.slot : undefined;
  const incarnation = subject.assistantScope === "global" ? subject.incarnation : undefined;

  const ctx = useMemo(
    () => ({ assistantScope, projectId, terminalId, agentId }),
    [assistantScope, projectId, terminalId, agentId]
  );
  const items = usePluginContextMenuItems("assistant", ctx);
  const dispatchArgs = useMemo(
    () => ({
      assistantScope,
      ...(projectId !== undefined && { projectId }),
      ...(slot !== undefined && { slot }),
      ...(terminalId !== undefined && { terminalId }),
      ...(incarnation !== undefined && { incarnation }),
      ...(agentId !== undefined && { agentId }),
    }),
    [assistantScope, projectId, slot, terminalId, incarnation, agentId]
  );

  return (
    <PluginContextMenuSection
      items={items}
      dispatchArgs={dispatchArgs}
      components={SECTION_COMPONENTS}
    />
  );
}
