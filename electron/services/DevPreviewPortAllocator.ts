import net from "node:net";

export const PORT_FREE_POLL_INTERVAL_MS = 200;
export const PORT_FREE_TIMEOUT_MS = 15_000;

export async function allocatePort(
  portRegistry: Map<string, number>,
  sessionKey: string
): Promise<number> {
  const existing = portRegistry.get(sessionKey);
  if (existing !== undefined) return existing;

  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = 3000 + Math.floor(Math.random() * 7000);
    const usedPorts = new Set(portRegistry.values());
    if (usedPorts.has(candidate)) continue;
    // Reserve before the async probe so concurrent allocatePort() calls for
    // different session keys can't pick the same candidate between probe and registration.
    portRegistry.set(sessionKey, candidate);
    const available = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", () => resolve(false));
      // Gap between close() and the dev server's eventual bind() is an intrinsic TOCTOU we accept.
      srv.listen(candidate, "0.0.0.0", () => srv.close(() => resolve(true)));
    });
    if (available) return candidate;
    releasePort(portRegistry, sessionKey);
  }
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", (err) => reject(err));
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => {
        if (port) {
          portRegistry.set(sessionKey, port);
          resolve(port);
        } else {
          reject(new Error("Failed to allocate port"));
        }
      });
    });
  });
}

export function releasePort(portRegistry: Map<string, number>, sessionKey: string): void {
  portRegistry.delete(sessionKey);
}

/**
 * Wait for a TCP port to become bindable again. Returns true when free, false
 * on timeout or abort. Primarily addresses Windows TIME_WAIT after a force-kill
 * of a dev server — the kernel can hold the socket for up to ~240s, which
 * causes the next allocatePort/spawn to fail with EADDRINUSE on the same port.
 * Probes with the same listen() call allocatePort uses, so a "free" answer
 * here implies the allocator will also succeed (TOCTOU window aside).
 */
export async function waitForPortFree(
  port: number,
  signal: AbortSignal,
  timeoutMs = PORT_FREE_TIMEOUT_MS
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (signal.aborted) return false;
    if (await probePortFree(port, signal)) return true;
    if (signal.aborted) return false;
    try {
      await sleepWithAbort(PORT_FREE_POLL_INTERVAL_MS, signal);
    } catch {
      return false;
    }
  }
  return false;
}

function probePortFree(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let onAbort: () => void = () => {};
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    if (signal.aborted) {
      settle(false);
      return;
    }
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => settle(false));
    onAbort = () => {
      try {
        srv.close();
      } catch {
        // server may already be closing
      }
      settle(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      srv.listen(port, "0.0.0.0", () => srv.close(() => settle(true)));
    } catch {
      settle(false);
    }
  });
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
