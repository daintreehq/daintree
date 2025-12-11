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
 */
export function getProjectGradient(color?: string): string | undefined {
  if (!color) {
    return undefined;
  }

  if (!isValidHexColor(color)) {
    console.warn(`[colorUtils] Invalid color format: ${color}`);
    return undefined;
  }

  // Only append 'dd' opacity if color doesn't already have alpha channel (8-digit hex)
  const hasAlpha = color.length === 5 || color.length === 9; // #RGBA or #RRGGBBAA
  const fadeColor = hasAlpha ? color : `${color}dd`;

  return `linear-gradient(135deg, ${color}, ${fadeColor})`;
}
