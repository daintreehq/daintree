import { SquareTerminal, Globe, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PanelKind } from "@/types";
import type { ComponentType } from "react";
import { getAgentConfig } from "@/config/agents";
import { resolveEffectiveAgentId } from "@/utils/agentIdentity";
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

const PROCESS_ICON_MAP: Record<string, ComponentType<{ className?: string; size?: number }>> = {
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
};

export interface TerminalIconProps {
  kind?: PanelKind;
  agentId?: string;
  /**
   * Runtime-detected agent (cleared when the agent exits). Takes precedence
   * over `agentId` so the icon reflects the live process, not the launch intent.
   */
  detectedAgentId?: string;
  detectedProcessId?: string;
  className?: string;
  brandColor?: string;
}

export function TerminalIcon({
  kind,
  agentId,
  detectedAgentId,
  detectedProcessId,
  className,
  brandColor,
}: TerminalIconProps) {
  const finalProps = {
    className: cn("w-4 h-4", className),
    "aria-hidden": "true" as const,
  };

  // Browser panes get a globe icon
  if (kind === "browser") {
    return <Globe {...finalProps} className={cn(finalProps.className, "text-status-info")} />;
  }

  // Dev preview panes get a monitor icon
  if (kind === "dev-preview") {
    return <Monitor {...finalProps} className={cn(finalProps.className, "text-status-info")} />;
  }

  // Prefer runtime-detected identity, then launch-time agentId.
  const effectiveAgentId = resolveEffectiveAgentId(detectedAgentId, agentId);

  if (effectiveAgentId) {
    const config = getAgentConfig(effectiveAgentId);
    if (config) {
      const Icon = config.icon;
      return <Icon {...finalProps} brandColor={brandColor ?? config.color} />;
    }
  }

  // Dynamic process icon for detected running processes (neutral color via currentColor)
  if (detectedProcessId) {
    const ProcessIcon = PROCESS_ICON_MAP[detectedProcessId];
    if (ProcessIcon) {
      return <ProcessIcon {...finalProps} />;
    }
    const detectedAgentConfig = getAgentConfig(detectedProcessId);
    if (detectedAgentConfig) {
      const AgentIcon = detectedAgentConfig.icon;
      return <AgentIcon {...finalProps} brandColor={brandColor} />;
    }
  }

  // Fallback to generic terminal icon
  return <SquareTerminal {...finalProps} />;
}
