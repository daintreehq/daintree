import { getDevServerOrigins } from "../config/devServer.js";

const PRODUCTION_ORIGINS = ["app://daintree"] as const;

function getTrustedRendererOrigins(): readonly string[] {
  const isDev = process.env.NODE_ENV === "development";
  return isDev ? [...PRODUCTION_ORIGINS, ...getDevServerOrigins()] : PRODUCTION_ORIGINS;
}

function getRendererOrigin(urlString: string): string | null {
  try {
    const url = new URL(urlString);

    if (!url.protocol || !url.host) return null;

    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function isTrustedRendererUrl(urlString: string): boolean {
  const origin = getRendererOrigin(urlString);
  if (!origin) return false;
  const trustedOrigins = getTrustedRendererOrigins();
  return trustedOrigins.includes(origin as any);
}

export function isRecoveryPageUrl(urlString: string): boolean {
  if (!isTrustedRendererUrl(urlString)) return false;
  try {
    const url = new URL(urlString);
    return url.pathname === "/recovery.html";
  } catch {
    return false;
  }
}

export function getTrustedOrigins(): readonly string[] {
  return getTrustedRendererOrigins();
}
