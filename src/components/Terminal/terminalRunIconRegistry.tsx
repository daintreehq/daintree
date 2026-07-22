import type { ComponentType } from "react";
import { AGENT_ICON_MAP } from "@/config/agentIcons";
import { getAgentConfig } from "@/config/agents";
import {
  NpmIcon,
  YarnIcon,
  PnpmIcon,
  BunIcon,
  PythonIcon,
  ComposerIcon,
  DockerIcon,
  RustIcon,
  GoIcon,
  RubyIcon,
  NodeIcon,
  DenoIcon,
  GradleIcon,
  PhpIcon,
  ViteIcon,
  WebpackIcon,
  KotlinIcon,
  SwiftIcon,
  TerraformIcon,
  ElixirIcon,
} from "@/components/icons";

export interface TerminalRunIconProps {
  className?: string;
  size?: number;
  brandColor?: string;
}

const PROCESS_RUN_ICON_MAP = {
  npm: NpmIcon,
  yarn: YarnIcon,
  pnpm: PnpmIcon,
  bun: BunIcon,
  python: PythonIcon,
  composer: ComposerIcon,
  docker: DockerIcon,
  rust: RustIcon,
  go: GoIcon,
  ruby: RubyIcon,
  node: NodeIcon,
  deno: DenoIcon,
  gradle: GradleIcon,
  php: PhpIcon,
  vite: ViteIcon,
  webpack: WebpackIcon,
  kotlin: KotlinIcon,
  swift: SwiftIcon,
  terraform: TerraformIcon,
  elixir: ElixirIcon,
} satisfies Record<string, ComponentType<TerminalRunIconProps>>;

export const TERMINAL_RUN_ICON_MAP: Record<string, ComponentType<TerminalRunIconProps>> = {
  ...AGENT_ICON_MAP,
  ...PROCESS_RUN_ICON_MAP,
};

export function resolveTerminalRunIcon(
  iconId: string | null | undefined
): ComponentType<TerminalRunIconProps> | undefined {
  if (!iconId) return undefined;
  // Own-key check: `iconId` can come from a plugin manifest, and a bare index
  // would hand back an inherited `Object.prototype` method as a "component".
  if (Object.hasOwn(TERMINAL_RUN_ICON_MAP, iconId)) return TERMINAL_RUN_ICON_MAP[iconId];
  // An agent's registry id isn't always its icon id (`daintree-assistant` maps
  // to `daintreeassistant`). `PanelKindIcon` resolves the registry id via
  // `getAgentConfig`, so accept it here too — otherwise the same manifest
  // `iconId` shows a brand mark in the palette and a terminal glyph in the tab.
  const agentIconId = getAgentConfig(iconId)?.iconId;
  if (agentIconId && Object.hasOwn(TERMINAL_RUN_ICON_MAP, agentIconId)) {
    return TERMINAL_RUN_ICON_MAP[agentIconId];
  }
  return undefined;
}
