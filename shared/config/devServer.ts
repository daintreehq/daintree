const DEFAULT_DEV_SERVER_PROTOCOL = "http:";
const DEFAULT_DEV_SERVER_HOST = "127.0.0.1";
export const DEFAULT_DEV_SERVER_PORT = 5173;

type EnvLike = NodeJS.ProcessEnv;

interface DevServerConfig {
  host: string;
  origin: string;
  port: number;
  protocol: "http:" | "https:";
}

function parsePort(value: string | undefined): number | null {
  if (!value) return null;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }

  return parsed;
}

function normalizeDevServerUrl(url: string): DevServerConfig | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    const port =
      parsePort(parsed.port) ??
      (parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : null);
    if (!port) return null;

    return {
      host: parsed.hostname,
      origin: `${parsed.protocol}//${parsed.hostname}:${port}`,
      port,
      protocol: parsed.protocol,
    };
  } catch {
    return null;
  }
}

export function getDevServerConfig(env: EnvLike = process.env): DevServerConfig {
  const explicitUrl = env.DAINTREE_DEV_SERVER_URL?.trim();
  if (explicitUrl) {
    const normalized = normalizeDevServerUrl(explicitUrl);
    if (normalized) {
      return normalized;
    }
  }

  const host = env.DAINTREE_DEV_SERVER_HOST?.trim() || DEFAULT_DEV_SERVER_HOST;
  const port = parsePort(env.DAINTREE_DEV_SERVER_PORT) ?? DEFAULT_DEV_SERVER_PORT;

  return {
    host,
    origin: `${DEFAULT_DEV_SERVER_PROTOCOL}//${host}:${port}`,
    port,
    protocol: DEFAULT_DEV_SERVER_PROTOCOL,
  };
}

export function getDevServerUrl(env: EnvLike = process.env): string {
  return getDevServerConfig(env).origin;
}

export function getDevServerOrigins(env: EnvLike = process.env): string[] {
  const config = getDevServerConfig(env);
  const origins = new Set([config.origin]);

  if (config.host === "127.0.0.1") {
    origins.add(`${config.protocol}//localhost:${config.port}`);
  } else if (config.host === "localhost") {
    origins.add(`${config.protocol}//127.0.0.1:${config.port}`);
  }

  return [...origins];
}

export function getDevServerWebSocketOrigins(env: EnvLike = process.env): string[] {
  return getDevServerOrigins(env).map((origin) =>
    origin.startsWith("https:") ? origin.replace("https:", "wss:") : origin.replace("http:", "ws:")
  );
}
