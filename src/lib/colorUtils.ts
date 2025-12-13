import { getAgentConfig } from "@/config/agents";

function isValidHexColor(color: string): boolean {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(color);
}

export function getBrandColorHex(agentIdOrType?: string): string | undefined {
  if (!agentIdOrType || agentIdOrType === "terminal") {
    return undefined;
  }
  const config = getAgentConfig(agentIdOrType);
  return config?.color;
}

/**
 * Validates color to prevent CSS injection
 * Uses color-mix for lightness shift to create depth
 */
export function getProjectGradient(color?: string): string | undefined {
  if (!color) {
    return undefined;
  }

  if (!isValidHexColor(color)) {
    console.warn(`[colorUtils] Invalid color format: ${color}`);
    return undefined;
  }

  // Create gradient with lightness shift for depth
  const lighterColor = `color-mix(in oklab, ${color} 85%, white)`;
  const darkerColor = `color-mix(in oklab, ${color} 85%, black)`;

  return `linear-gradient(135deg, ${lighterColor}, ${darkerColor})`;
}
