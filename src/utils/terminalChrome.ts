import type { AgentId, AgentState } from "@shared/types/agent";
import type { PanelKind } from "@/types";
import type { TerminalRuntimeIdentity } from "@shared/types/panel";
import { getPanelKindColor, getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { getAgentConfig } from "@/config/agents";

export interface TerminalChromeInput {
  kind?: PanelKind;
  launchAgentId?: AgentId | string;
  runtimeIdentity?: TerminalRuntimeIdentity | null;
  detectedAgentId?: AgentId | string;
  detectedProcessId?: string;
  agentState?: AgentState | string;
  runtimeStatus?: string;
  exitCode?: number | null;
  everDetectedAgent?: boolean;
  presetColor?: string;
  agentPresetColor?: string;
}

export interface TerminalChromeDescriptor {
  iconId: string | null;
  color?: string;
  label: string;
  isAgent: boolean;
  agentId: AgentId | null;
  processId: string | null;
  runtimeKind: TerminalRuntimeIdentity["kind"] | "panel" | "none";
}

const PROCESS_LABELS: Record<string, string> = {
  npm: "npm",
  yarn: "Yarn",
  pnpm: "pnpm",
  bun: "Bun",
  python: "Python",
  composer: "Composer",
  docker: "Docker",
  rust: "Rust",
  go: "Go",
  ruby: "Ruby",
  node: "Node.js",
  deno: "Deno",
  gradle: "Gradle",
  php: "PHP",
  vite: "Vite",
  webpack: "webpack",
  kotlin: "Kotlin",
  swift: "Swift",
  terraform: "Terraform",
  elixir: "Elixir",
};

function normalizeProcessId(processId: string | undefined): string | undefined {
  const trimmed = processId?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function makeAgentIdentity(agentId: AgentId | string, processId?: string): TerminalRuntimeIdentity {
  const config = getAgentConfig(agentId);
  return {
    kind: "agent",
    id: agentId,
    iconId: config?.iconId ?? agentId,
    agentId,
    ...(processId ? { processId } : undefined),
  };
}

function makeProcessIdentity(processId: string): TerminalRuntimeIdentity {
  return {
    kind: "process",
    id: processId,
    iconId: processId,
    processId,
  };
}

function hasExplicitAgentExit(input: TerminalChromeInput | undefined): boolean {
  return (
    input?.agentState === "exited" ||
    input?.runtimeStatus === "exited" ||
    input?.runtimeStatus === "error" ||
    typeof input?.exitCode === "number"
  );
}

function hasClearedStickyAgentDetection(input: TerminalChromeInput | undefined): boolean {
  return (
    input?.everDetectedAgent === true &&
    input.detectedAgentId === undefined &&
    input.agentState === undefined
  );
}

function deriveChromeAgentIdentity(
  input: TerminalChromeInput | undefined
): TerminalRuntimeIdentity | null {
  if (input?.detectedAgentId) {
    return makeAgentIdentity(input.detectedAgentId, normalizeProcessId(input.detectedProcessId));
  }

  const current = input?.runtimeIdentity;
  if (current?.kind === "agent" && current.agentId) {
    return makeAgentIdentity(current.agentId, current.processId);
  }

  if (
    input?.launchAgentId &&
    !hasExplicitAgentExit(input) &&
    !hasClearedStickyAgentDetection(input)
  ) {
    return makeAgentIdentity(input.launchAgentId, normalizeProcessId(input.detectedProcessId));
  }

  return null;
}

function deriveChromeProcessIdentity(
  input: TerminalChromeInput | undefined
): TerminalRuntimeIdentity | null {
  const detectedProcessId = normalizeProcessId(input?.detectedProcessId);
  if (detectedProcessId) {
    return makeProcessIdentity(detectedProcessId);
  }

  const current = input?.runtimeIdentity;
  if (current?.kind !== "process") {
    return null;
  }

  const processId = normalizeProcessId(current.processId ?? current.id ?? current.iconId);
  return processId ? makeProcessIdentity(processId) : null;
}

export function deriveTerminalRuntimeIdentity(
  input: TerminalChromeInput | undefined
): TerminalRuntimeIdentity | null {
  if (input?.detectedAgentId) {
    return makeAgentIdentity(input.detectedAgentId, normalizeProcessId(input.detectedProcessId));
  }

  const detectedProcessId = normalizeProcessId(input?.detectedProcessId);
  if (detectedProcessId) {
    return makeProcessIdentity(detectedProcessId);
  }

  const current = input?.runtimeIdentity;
  if (current?.kind === "agent" && current.agentId) {
    return makeAgentIdentity(current.agentId, current.processId);
  }
  if (current?.kind === "process") {
    const processId = normalizeProcessId(current.processId ?? current.id ?? current.iconId);
    return processId ? makeProcessIdentity(processId) : null;
  }

  return null;
}

export function terminalRuntimeIdentitiesEqual(
  left: TerminalRuntimeIdentity | null | undefined,
  right: TerminalRuntimeIdentity | null | undefined
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.iconId === right.iconId &&
    left.agentId === right.agentId &&
    left.processId === right.processId
  );
}

export function terminalChromeDescriptorsEqual(
  left: TerminalChromeDescriptor | undefined,
  right: TerminalChromeDescriptor | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.iconId === right.iconId &&
    left.color === right.color &&
    left.label === right.label &&
    left.isAgent === right.isAgent &&
    left.agentId === right.agentId &&
    left.processId === right.processId &&
    left.runtimeKind === right.runtimeKind
  );
}

export function deriveTerminalChrome(input: TerminalChromeInput = {}): TerminalChromeDescriptor {
  const kind = input.kind ?? "terminal";
  if (kind === "browser" || kind === "dev-preview") {
    const config = getPanelKindConfig(kind);
    return {
      iconId: config?.iconId ?? null,
      color: config?.color ?? getPanelKindColor(kind),
      label: config?.name ?? kind,
      isAgent: false,
      agentId: null,
      processId: null,
      runtimeKind: "panel",
    };
  }

  const agentIdentity = deriveChromeAgentIdentity(input);
  const agentId = agentIdentity?.agentId;
  if (agentIdentity && agentId) {
    const identity = agentIdentity;
    const config = getAgentConfig(agentId);
    const presetColor = input.presetColor ?? input.agentPresetColor;
    return {
      iconId: config?.iconId ?? identity.iconId,
      color: presetColor ?? config?.color ?? getPanelKindColor(kind),
      label: config?.name ?? agentId,
      isAgent: true,
      agentId,
      processId: identity.processId ?? null,
      runtimeKind: "agent",
    };
  }

  const processIdentity = deriveChromeProcessIdentity(input);
  if (processIdentity?.kind === "process") {
    const identity = processIdentity;
    const config = getAgentConfig(identity.iconId);
    return {
      iconId: identity.iconId,
      color: config?.color ?? getPanelKindColor(kind),
      label: config?.name ?? PROCESS_LABELS[identity.iconId] ?? identity.iconId,
      isAgent: false,
      agentId: null,
      processId: identity.processId ?? identity.id,
      runtimeKind: "process",
    };
  }

  const config = getPanelKindConfig(kind);
  return {
    iconId: null,
    color: config?.color ?? getPanelKindColor(kind),
    label: config?.name ?? "Terminal",
    isAgent: false,
    agentId: null,
    processId: null,
    runtimeKind: "none",
  };
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
