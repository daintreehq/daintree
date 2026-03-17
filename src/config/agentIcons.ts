import type { ComponentType } from "react";
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

const FallbackIcon = ICON_MAP["claude"]!;

export function resolveAgentIcon(iconId: string): ComponentType<AgentIconProps> {
  return ICON_MAP[iconId] ?? FallbackIcon;
}

export { ICON_MAP as AGENT_ICON_MAP };
