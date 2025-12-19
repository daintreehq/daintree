import { shell } from "electron";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

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
  } catch (error) {
    throw new Error(`Invalid URL: ${trimmed}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Protocol ${parsed.protocol} is not allowed`);
  }

  await shell.openExternal(parsed.toString(), { activate: true });
}
