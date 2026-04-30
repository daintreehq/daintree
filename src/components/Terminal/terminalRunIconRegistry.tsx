import type { ComponentType } from "react";
import { AGENT_ICON_MAP } from "@/config/agentIcons";
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
  return iconId ? TERMINAL_RUN_ICON_MAP[iconId] : undefined;
}
