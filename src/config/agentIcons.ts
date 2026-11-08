import { createElement, type ComponentType } from "react";
import { SquareTerminal } from "lucide-react";
import { isPluginCustomIconKey } from "@shared/config/pluginCustomIcon";
import { getPluginCustomIconComponent } from "@/components/icons/PluginCustomIcon";
import type { PluginIconProps } from "@/components/icons/pluginIconRegistry";
import type { AgentIconProps } from "./agents";

const modules = import.meta.glob<ComponentType<AgentIconProps>>(
  "../components/icons/brands/*Icon.tsx",
  { eager: true, import: "default" }
);

const ICON_MAP: Record<string, ComponentType<AgentIconProps>> = {};
for (const [path, component] of Object.entries(modules)) {
  const filename = path.split("/").at(-1)!;
  const iconId = filename.replace(/Icon\.tsx$/, "").toLowerCase();
  ICON_MAP[iconId] = component;
}

/**
 * Brand marks default to 16px where Lucide glyphs and plugin SVGs default to 24,
 * and several agent surfaces render `<config.icon />` with no size of their own.
 */
const AGENT_MARK_SIZE = 16;

/** For an agent with no drawable mark: a generic glyph, never another agent's mark. */
function NeutralAgentIcon({ size = AGENT_MARK_SIZE, ...props }: PluginIconProps) {
  return createElement(SquareTerminal, { size, ...props });
}

const customAgentMarks = new Map<string, ComponentType<AgentIconProps>>();

/** Cached so a caller resolving on every render keeps one component identity. */
function getCustomAgentMark(key: string): ComponentType<AgentIconProps> {
  let mark = customAgentMarks.get(key);
  if (!mark) {
    const CustomIcon = getPluginCustomIconComponent(key, NeutralAgentIcon);
    mark = function CustomAgentMark({ size = AGENT_MARK_SIZE, ...props }: AgentIconProps) {
      return createElement(CustomIcon, { size, ...props });
    };
    customAgentMarks.set(key, mark);
  }
  return mark;
}

export function resolveAgentIcon(iconId: string): ComponentType<AgentIconProps> {
  // Own-key check: `iconId` can come from a plugin manifest, and a bare index
  // would hand back an inherited `Object.prototype` method as a "component".
  if (Object.hasOwn(ICON_MAP, iconId)) return ICON_MAP[iconId]!;
  return isPluginCustomIconKey(iconId) ? getCustomAgentMark(iconId) : NeutralAgentIcon;
}

export { ICON_MAP as AGENT_ICON_MAP };
