import { useEffect, useMemo, useState } from "react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { PluginContextMenuSection } from "@/components/Plugin/PluginContextMenuSection";
import { usePluginContextMenuItems } from "@/hooks/usePluginContextMenuItems";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";

/**
 * The assistant session a plugin `assistant` item was opened on, as its action
 * receives it. `slot` and `incarnation` are numbers, which a `when` clause has no
 * type for, so they reach the action only.
 */
export type AssistantPluginMenuSubject =
  | {
      assistantScope: "project";
      /** The project, or scratch workspace, whose Assistant panel holds the lane. */
      projectId: string;
      /** The lane's zero-based slot, stable across relaunches of that lane. */
      slot: number;
      /** Absent while the lane has no terminal: paused, or still launching. */
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

const SECTION_COMPONENTS = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };

function subjectIdentity(subject: AssistantPluginMenuSubject): string {
  return subject.assistantScope === "global"
    ? `global:${subject.terminalId}:${subject.incarnation}`
    : `project:${subject.projectId}:${subject.slot}:${subject.terminalId ?? ""}`;
}

/**
 * Plugin `assistant` context-menu items for an Assistant panel menu (#18138), as
 * a trailing section with its own leading separator. Mount it inside the menu's
 * content, so it lives only while the menu is open.
 *
 * The session is the one the menu opened on: if the lane or run it names is
 * replaced while the menu is open, the rows go until the menu is opened again,
 * so a pick never lands on a successor the person didn't choose. Built-in rows
 * are unaffected.
 *
 * With no plugin contributing an `assistant` item this renders nothing and
 * subscribes to nothing beyond the shared item store.
 */
export function AssistantPluginMenuItems({ subject }: { subject: AssistantPluginMenuSubject }) {
  const init = usePluginContextMenuItemsStore((s) => s.init);
  const hasAssistantItems = usePluginContextMenuItemsStore((s) =>
    s.entries.some((entry) => entry.item.location === "assistant")
  );
  const identity = subjectIdentity(subject);
  const [openedOn] = useState(identity);

  useEffect(() => {
    init();
  }, [init]);

  if (!hasAssistantItems || identity !== openedOn) return null;
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
