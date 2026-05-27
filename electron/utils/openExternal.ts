import { shell } from "electron";

/**
 * Build the set of URL protocols `openExternalUrl` is allowed to hand to the
 * system. Platform-specific schemes are gated to the platform that owns them:
 * `ms-windows-store:` / `ms-settings:` only resolve meaningfully on Windows,
 * and `x-apple.systempreferences:` only on macOS. Allowlisting them everywhere
 * would widen the attack surface on platforms where a third-party app could
 * register the scheme.
 */
export function buildAllowedProtocols(platform: NodeJS.Platform): Set<string> {
  return new Set([
    "http:",
    "https:",
    "mailto:",
    ...(platform === "win32" ? ["ms-windows-store:", "ms-settings:"] : []),
    ...(platform === "darwin" ? ["x-apple.systempreferences:"] : []),
  ]);
}

const ALLOWED_PROTOCOLS = buildAllowedProtocols(process.platform);

export function canOpenExternalUrl(url: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url.trim()).protocol);
  } catch {
    return false;
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Protocol ${parsed.protocol} is not allowed`);
  }

  await shell.openExternal(parsed.toString(), { activate: true });
}
