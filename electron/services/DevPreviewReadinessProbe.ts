import http from "node:http";
import https from "node:https";
import WebSocket from "ws";

export const READINESS_TIMEOUT_MS = 30000;
export const READINESS_POLL_INTERVAL_MS = 500;
export const READINESS_REQUEST_TIMEOUT_MS = 5000;
export const READINESS_HMR_TIMEOUT_MS = 1500;

type ProbeResult = "ready" | "5xx" | "fail";

const HMR_PROBE_CANDIDATES: ReadonlyArray<{ path: string; subprotocols?: string[] }> = [
  { path: "/", subprotocols: ["vite-hmr"] },
  { path: "/_next/webpack-hmr" },
  { path: "/ws" },
];

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

async function probeUrl(url: string, useHttps: boolean, signal: AbortSignal): Promise<ProbeResult> {
  const requestModule = useHttps ? https : http;

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let onAbort: () => void = () => {};
    const settle = (value: ProbeResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    try {
      const req = requestModule.request(
        url,
        {
          method: "GET",
          timeout: READINESS_REQUEST_TIMEOUT_MS,
          ...(useHttps ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 400) {
            settle("ready");
          } else if (status >= 500 && status < 600) {
            settle("5xx");
          } else {
            settle("fail");
          }
        }
      );
      onAbort = () => {
        req.destroy();
        settle("fail");
      };
      req.on("error", () => settle("fail"));
      req.on("timeout", () => {
        req.destroy();
        settle("fail");
      });
      if (signal.aborted) {
        req.destroy();
        settle("fail");
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        req.end();
      }
    } catch {
      settle("fail");
    }
  });
}

export async function probeHmrWebSocket(
  httpUrl: string,
  signal: AbortSignal,
  timeoutMs = READINESS_HMR_TIMEOUT_MS
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(httpUrl);
  } catch {
    return false;
  }

  const wsScheme = parsed.protocol === "https:" ? "wss:" : "ws:";
  const origin = `${parsed.protocol}//${parsed.host}`;
  const sockets: WebSocket[] = [];

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal.removeEventListener("abort", onAbort);
      for (const socket of sockets) {
        try {
          socket.terminate();
        } catch {
          // best-effort cleanup
        }
      }
    };

    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    if (signal.aborted) {
      settle(false);
      return;
    }

    let pending = HMR_PROBE_CANDIDATES.length;

    const isSecure = wsScheme === "wss:";
    const baseOptions = {
      headers: { Origin: origin },
      ...(isSecure ? { rejectUnauthorized: false } : {}),
    };

    for (const candidate of HMR_PROBE_CANDIDATES) {
      const wsUrl = `${wsScheme}//${parsed.host}${candidate.path}`;
      let socket: WebSocket;
      try {
        socket = candidate.subprotocols
          ? new WebSocket(wsUrl, candidate.subprotocols, baseOptions)
          : new WebSocket(wsUrl, baseOptions);
      } catch {
        pending -= 1;
        if (pending === 0) settle(false);
        continue;
      }
      sockets.push(socket);

      socket.once("open", () => settle(true));
      const onFail = () => {
        pending -= 1;
        if (pending === 0 && !settled) settle(false);
      };
      socket.once("error", onFail);
      socket.once("close", onFail);
    }

    if (pending === 0) {
      settle(false);
      return;
    }

    onAbort = () => settle(false);
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => settle(false), timeoutMs);
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

  let hasSeen5xx = false;
  let awaitingConfirmation = false;

  while (performance.now() < deadline) {
    if (signal.aborted) return false;

    for (const candidateUrl of urls) {
      if (signal.aborted) return false;
      const result = await probeUrl(candidateUrl, useHttps, signal);
      if (result === "5xx") {
        hasSeen5xx = true;
        awaitingConfirmation = false;
      } else if (result === "ready") {
        if (!hasSeen5xx || awaitingConfirmation) {
          await probeHmrWebSocket(candidateUrl, signal);
          if (signal.aborted) return false;
          return true;
        }
        awaitingConfirmation = true;
      }
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
