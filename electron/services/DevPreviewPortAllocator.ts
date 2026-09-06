import net from "node:net";

export const PORT_FREE_POLL_INTERVAL_MS = 200;
export const PORT_FREE_TIMEOUT_MS = 15_000;

const MAX_OS_ASSIGNED_ATTEMPTS = 10;

type FamilyProbeResult = "free" | "busy" | "unavailable" | "error";

// A bind failure is only evidence the port is taken when the kernel says so.
// Everything else on the IPv6 leg means "this host has no usable IPv6", which
// must not make an otherwise-free port look occupied.
const IPV6_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "EAFNOSUPPORT",
  "EADDRNOTAVAIL",
  "ENOPROTOOPT",
  "EINVAL",
]);

function classifyBindError(err: NodeJS.ErrnoException, ipv6Only: boolean): FamilyProbeResult {
  if (err.code === "EADDRINUSE") return "busy";
  if (ipv6Only && err.code && IPV6_UNAVAILABLE_CODES.has(err.code)) return "unavailable";
  return "error";
}

/**
 * Try to bind one address family and report what the kernel said. Binding
 * `0.0.0.0` never also claims `::` (and whether `::` claims IPv4 depends on
 * IPV6_V6ONLY), so the two families need independent probes — `ipv6Only` keeps
 * the IPv6 leg from dual-claiming and confusing the two answers.
 */
function probeFamily(
  port: number,
  host: string,
  ipv6Only: boolean,
  signal?: AbortSignal
): Promise<FamilyProbeResult> {
  return new Promise<FamilyProbeResult>((resolve) => {
    let settled = false;
    let onAbort: () => void = () => {};
    const settle = (value: FamilyProbeResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    if (signal?.aborted) {
      settle("error");
      return;
    }
    const srv = net.createServer();
    srv.unref();
    srv.once("error", (err) => settle(classifyBindError(err as NodeJS.ErrnoException, ipv6Only)));
    onAbort = () => {
      try {
        srv.close();
      } catch {
        // server may already be closing
      }
      settle("error");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      srv.listen({ port, host, ipv6Only }, () => srv.close(() => settle("free")));
    } catch {
      settle("error");
    }
  });
}

/**
 * Every address a local dev server might take. Node sets SO_REUSEADDR, so a
 * wildcard bind succeeds while a *loopback* listener holds the same port —
 * measured, not assumed: with `::1` held, both `0.0.0.0` and `::` still bind.
 * The wildcards alone therefore miss exactly the servers that matter here
 * (Vite binds `[::1]` on macOS — see #9752), so each address is probed.
 */
const PROBE_ADDRESSES: ReadonlyArray<{ host: string; ipv6: boolean }> = [
  { host: "0.0.0.0", ipv6: false },
  { host: "127.0.0.1", ipv6: false },
  { host: "::", ipv6: true },
  { host: "::1", ipv6: true },
];

/**
 * True only when the port is bindable at every address this host can actually
 * use. The IPv4-only check that shipped in #12295 handed out a port an
 * `ipv6Only` `::1` listener was holding. A host with no usable IPv6 answers
 * "unavailable" there, which is not the same as "occupied" and must not block
 * allocation. Gap between close() and the dev server's eventual bind() is an
 * intrinsic TOCTOU we accept.
 */
export async function probePortFree(port: number, signal?: AbortSignal): Promise<boolean> {
  const results = await Promise.all(
    PROBE_ADDRESSES.map(({ host, ipv6 }) => probeFamily(port, host, ipv6, signal))
  );
  if (signal?.aborted) return false;
  return results.every(
    (result, index) =>
      result === "free" || (PROBE_ADDRESSES[index].ipv6 && result === "unavailable")
  );
}

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
    if (await probePortFree(candidate)) return candidate;
    releasePort(portRegistry, sessionKey);
  }

  // Fall back to an OS-assigned port. It is only IPv4-assigned, so it still
  // needs the IPv6 leg checked, and another session may have reserved the same
  // number while we were binding.
  for (let attempt = 0; attempt < MAX_OS_ASSIGNED_ATTEMPTS; attempt++) {
    const port = await requestOsAssignedPort();
    if (port === null) continue;
    if (new Set(portRegistry.values()).has(port)) continue;
    portRegistry.set(sessionKey, port);
    if (await probePortFree(port)) return port;
    releasePort(portRegistry, sessionKey);
  }
  throw new Error("Failed to allocate port");
}

function requestOsAssignedPort(): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let settled = false;
    const settle = (value: number | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => settle(null));
    try {
      srv.listen({ port: 0, host: "0.0.0.0" }, () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => settle(port > 0 ? port : null));
      });
    } catch {
      settle(null);
    }
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
 * Probes with the same dual-family check allocatePort uses, so a "free" answer
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
