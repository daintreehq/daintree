import http from "node:http";
import https from "node:https";

export const READINESS_TIMEOUT_MS = 30000;
export const READINESS_POLL_INTERVAL_MS = 500;
export const READINESS_REQUEST_TIMEOUT_MS = 5000;

export async function waitForServerReady(
  url: string,
  signal: AbortSignal,
  timeoutMs = READINESS_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let useHttps: boolean;
  try {
    useHttps = new URL(url).protocol === "https:";
  } catch {
    return false;
  }
  const requestModule = useHttps ? https : http;

  while (Date.now() < deadline) {
    if (signal.aborted) return false;

    const ready = await new Promise<boolean>((resolve) => {
      let settled = false;
      const onAbort = () => {
        req?.destroy();
        settle(false);
      };
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };

      let req: ReturnType<typeof requestModule.request> | undefined;
      try {
        req = requestModule.request(
          url,
          {
            method: "HEAD",
            timeout: READINESS_REQUEST_TIMEOUT_MS,
            ...(useHttps ? { rejectUnauthorized: false } : {}),
          },
          (res) => {
            res.resume();
            const status = res.statusCode ?? 0;
            // Any HTTP response means the server is listening and can process requests.
            // We only keep polling on transport-level failures (connection refused, timeout, etc.).
            if (status >= 100 && status < 600) {
              settle(true);
            } else {
              settle(false);
            }
          }
        );
        req.on("error", () => settle(false));
        req.on("timeout", () => {
          req!.destroy();
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

    if (ready) return true;
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
