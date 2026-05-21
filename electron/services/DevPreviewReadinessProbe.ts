import http from "node:http";
import https from "node:https";

export const READINESS_TIMEOUT_MS = 30000;
export const READINESS_POLL_INTERVAL_MS = 500;
export const READINESS_REQUEST_TIMEOUT_MS = 5000;

function buildReadinessUrls(url: string): string[] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const urls = [parsed.toString()];
  if (parsed.hostname === "localhost") {
    for (const hostname of ["127.0.0.1", "[::1]"]) {
      const candidate = new URL(parsed.toString());
      candidate.hostname = hostname;
      urls.push(candidate.toString());
    }
  }

  return [...new Set(urls)];
}

async function probeUrl(url: string, useHttps: boolean, signal: AbortSignal): Promise<boolean> {
  const requestModule = useHttps ? https : http;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let onAbort: () => void = () => {};
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    try {
      const req = requestModule.request(
        url,
        {
          method: "HEAD",
          timeout: READINESS_REQUEST_TIMEOUT_MS,
          ...(useHttps ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 500) {
            settle(true);
          } else {
            settle(false);
          }
        }
      );
      onAbort = () => {
        req.destroy();
        settle(false);
      };
      req.on("error", () => settle(false));
      req.on("timeout", () => {
        req.destroy();
        settle(false);
      });
      if (signal.aborted) {
        req.destroy();
        settle(false);
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        req.end();
      }
    } catch {
      settle(false);
    }
  });
}

export async function waitForServerReady(
  url: string,
  signal: AbortSignal,
  timeoutMs = READINESS_TIMEOUT_MS
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  let useHttps: boolean;
  const urls = buildReadinessUrls(url);
  if (!urls) return false;

  try {
    useHttps = new URL(url).protocol === "https:";
  } catch {
    return false;
  }

  while (performance.now() < deadline) {
    if (signal.aborted) return false;

    for (const candidateUrl of urls) {
      if (signal.aborted) return false;
      if (await probeUrl(candidateUrl, useHttps, signal)) return true;
    }

    if (signal.aborted) return false;

    try {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, READINESS_POLL_INTERVAL_MS);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    } catch {
      return false;
    }
  }

  return false;
}
