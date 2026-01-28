const PRODUCTION_ORIGINS = ["app://canopy"] as const;

const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"] as const;

function getTrustedRendererOrigins(): readonly string[] {
  const isDev = process.env.NODE_ENV === "development";
  return isDev ? [...PRODUCTION_ORIGINS, ...DEV_ORIGINS] : PRODUCTION_ORIGINS;
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

export function getTrustedOrigins(): readonly string[] {
  return getTrustedRendererOrigins();
}
