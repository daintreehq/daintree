import http from "node:http";
// From the allowlists config, not `./shared.js` — this module is on the eager
// boot path (HelpSessionService value-imports it) and `shared.js` value-imports
// the MCP SDK's `types.js`, which builds the full zod protocol schemas.
import { ACTIONS_LIST_TOOL } from "../../../shared/config/helpAssistantTierAllowlists.js";

export const PROBE_MAX_ATTEMPTS = 3;
export const PROBE_BASE_DELAY_MS = 50;
export const PROBE_REQUEST_TIMEOUT_MS = 1000;
export const PROBE_HARD_TIMEOUT_MS = 3000;
export const PROBE_SSE_REQUEST_TIMEOUT_MS = 6000;
export const PROBE_SSE_HARD_TIMEOUT_MS = 15000;
export const PROBE_PROTOCOL_VERSION = "2025-11-25";

export interface ProbeOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  requestTimeoutMs?: number;
  hardTimeoutMs?: number;
}

interface InitializeResult {
  sessionId: string;
}

/**
 * Active readiness probe — POSTs an MCP `initialize` request to the bound
 * MCP server and verifies the server responds with HTTP 200 plus a real
 * `mcp-session-id` header. This proves end-to-end that the HTTP handler,
 * auth path, and Streamable HTTP transport are all wired up — not just
 * that the OS socket is bound.
 *
 * On success the probe immediately tears down its own session via DELETE
 * so the probe doesn't linger as a zombie session for the 30-minute idle
 * window. DELETE failures are logged but non-fatal — the session will
 * idle out on its own.
 *
 * Throws if every attempt fails within the hard timeout.
 */
export async function probeMcpServer(
  port: number,
  bearerToken: string,
  options: ProbeOptions = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? PROBE_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? PROBE_BASE_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? PROBE_REQUEST_TIMEOUT_MS;
  const hardTimeoutMs = options.hardTimeoutMs ?? PROBE_HARD_TIMEOUT_MS;

  const deadline = Date.now() + hardTimeoutMs;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastError = lastError ?? new Error("hard timeout reached");
      break;
    }
    const perAttemptTimeout = Math.min(requestTimeoutMs, remaining);

    try {
      const result = await sendInitialize(port, bearerToken, perAttemptTimeout);
      // Best-effort cleanup so the probe session doesn't sit in the
      // session map for 30 minutes. Detached so the probe returns
      // immediately on success — the hard timeout only bounds initialize.
      // Cleanup gets its own per-request timeout regardless of remaining
      // budget; failures are logged but never bubble up.
      void sendDelete(port, bearerToken, result.sessionId, requestTimeoutMs).catch((err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ECONNRESET" || code === "EPIPE") return;
        console.warn("[MCP] Readiness probe cleanup DELETE failed (non-fatal):", err);
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= maxAttempts) break;

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      const remainingAfterAttempt = deadline - Date.now();
      if (remainingAfterAttempt <= 0) break;
      await wait(Math.min(delay, remainingAfterAttempt));
    }
  }

  const reason = lastError?.message ?? "unknown error";
  throw new Error(
    `MCP readiness probe failed after ${maxAttempts} attempt(s) on port ${port}: ${reason}`
  );
}

/**
 * Legacy-SSE readiness probe for the exact path Claude Code reads from the
 * assistant session's `.mcp.json`: GET /sse, receive the endpoint event, POST
 * JSON-RPC initialize to /messages, then request tools/list and verify a
 * renderer-backed action tool is available on the SSE stream. Closing the
 * stream tears the probe session down.
 */
export async function probeMcpSseServer(
  port: number,
  bearerToken: string,
  options: ProbeOptions = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? PROBE_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? PROBE_BASE_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? PROBE_SSE_REQUEST_TIMEOUT_MS;
  const hardTimeoutMs = options.hardTimeoutMs ?? PROBE_SSE_HARD_TIMEOUT_MS;

  const deadline = Date.now() + hardTimeoutMs;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastError = lastError ?? new Error("hard timeout reached");
      break;
    }
    const perAttemptTimeout = Math.min(requestTimeoutMs, remaining);

    try {
      await sendSseInitialize(port, bearerToken, perAttemptTimeout);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= maxAttempts) break;

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      const remainingAfterAttempt = deadline - Date.now();
      if (remainingAfterAttempt <= 0) break;
      await wait(Math.min(delay, remainingAfterAttempt));
    }
  }

  const reason = lastError?.message ?? "unknown error";
  throw new Error(
    `MCP SSE readiness probe failed after ${maxAttempts} attempt(s) on port ${port}: ${reason}`
  );
}

function sendInitialize(
  port: number,
  bearerToken: string,
  timeoutMs: number
): Promise<InitializeResult> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROBE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "daintree-readiness-probe", version: "1.0.0" },
    },
  });

  return new Promise<InitializeResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    let req: http.ClientRequest | undefined;
    try {
      req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          timeout: timeoutMs,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${bearerToken}`,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const headerValue = res.headers["mcp-session-id"];
          const sessionId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
          // Drop the SSE body — it's a long-lived stream, the headers are
          // the readiness signal.
          res.resume();

          if (status !== 200) {
            settle(() => {
              req?.destroy();
              reject(new Error(`status ${status}`));
            });
            return;
          }
          if (typeof sessionId !== "string" || sessionId.length === 0) {
            settle(() => {
              req?.destroy();
              reject(new Error("missing mcp-session-id response header"));
            });
            return;
          }
          settle(() => {
            req?.destroy();
            resolve({ sessionId });
          });
        }
      );

      req.on("error", (err) => {
        settle(() => reject(err));
      });
      req.on("timeout", () => {
        settle(() => {
          req?.destroy();
          reject(new Error("request timed out"));
        });
      });

      req.write(body);
      req.end();
    } catch (err) {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

function sendDelete(
  port: number,
  bearerToken: string,
  sessionId: string,
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    let req: http.ClientRequest | undefined;
    try {
      req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "DELETE",
          timeout: timeoutMs,
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Mcp-Session-Id": sessionId,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.resume();
          if (status === 405) {
            settle(() => resolve());
            return;
          }
          if (status < 200 || status >= 300) {
            settle(() => reject(new Error(`DELETE returned status ${status}`)));
            return;
          }
          settle(() => resolve());
        }
      );
      req.on("error", (err) => {
        settle(() => reject(err));
      });
      req.on("timeout", () => {
        settle(() => {
          req?.destroy();
          reject(new Error("DELETE timed out"));
        });
      });
      req.end();
    } catch (err) {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

interface ParsedSseEvent {
  event: string;
  data: string;
}

function sendSseInitialize(port: number, bearerToken: string, timeoutMs: number): Promise<void> {
  const initializeBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROBE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "daintree-readiness-probe", version: "1.0.0" },
    },
  });
  const toolsListBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let endpointPath: string | null = null;
    let sseBuffer = "";
    let getReq: http.ClientRequest | undefined;
    const postReqs = new Set<http.ClientRequest>();

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      getReq?.destroy();
      for (const req of postReqs) req.destroy();
      postReqs.clear();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error("request timed out")));
    }, timeoutMs);
    timer.unref?.();

    const postMessage = (path: string, payload: string, label: string) => {
      if (settled) return;
      try {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path,
            method: "POST",
            timeout: timeoutMs,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
              Authorization: `Bearer ${bearerToken}`,
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            res.resume();
            postReqs.delete(req);
            if (status !== 202) {
              settle(() => reject(new Error(`POST ${label} returned status ${status}`)));
            }
          }
        );
        postReqs.add(req);
        req.on("error", (err) => {
          postReqs.delete(req);
          settle(() => reject(err));
        });
        req.on("timeout", () => {
          postReqs.delete(req);
          settle(() => {
            req.destroy();
            reject(new Error(`POST ${label} timed out`));
          });
        });
        req.write(payload);
        req.end();
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    };

    const postInitialize = (path: string) => {
      postMessage(path, initializeBody, "initialize");
    };

    const postToolsList = (path: string) => {
      postMessage(path, toolsListBody, "tools/list");
    };

    const handleEvent = (event: ParsedSseEvent) => {
      if (event.event === "endpoint") {
        endpointPath = event.data.trim();
        if (!endpointPath.startsWith("/messages?")) {
          settle(() => reject(new Error(`invalid SSE endpoint path: ${endpointPath}`)));
          return;
        }
        postInitialize(endpointPath);
        return;
      }

      if (event.event !== "message") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        return;
      }
      if (!parsed || typeof parsed !== "object") {
        settle(() => reject(new Error("SSE response was not an object")));
        return;
      }
      const message = parsed as Record<string, unknown>;
      if (message.error) {
        settle(() => reject(new Error(`SSE response ${String(message.id)} returned an error`)));
        return;
      }
      if (message.id === 1) {
        if (!message.result || typeof message.result !== "object") {
          settle(() => reject(new Error("initialize response missing result")));
          return;
        }
        if (!endpointPath) {
          settle(() => reject(new Error("initialize completed before endpoint discovery")));
          return;
        }
        postToolsList(endpointPath);
        return;
      }
      if (message.id !== 2) return;
      const result = message.result;
      if (!result || typeof result !== "object") {
        settle(() => reject(new Error("tools/list response missing result")));
        return;
      }
      const tools = (result as Record<string, unknown>).tools;
      if (!Array.isArray(tools)) {
        settle(() => reject(new Error("tools/list response missing tools array")));
        return;
      }
      const hasManifestBackedTool = tools.some(
        (tool) =>
          tool &&
          typeof tool === "object" &&
          (tool as Record<string, unknown>).name === ACTIONS_LIST_TOOL
      );
      if (!hasManifestBackedTool) {
        settle(() => reject(new Error("tools/list response missing actions.list")));
        return;
      }
      settle(() => resolve());
    };

    try {
      getReq = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/sse",
          method: "GET",
          timeout: timeoutMs,
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${bearerToken}`,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            res.resume();
            settle(() => reject(new Error(`SSE returned status ${status}`)));
            return;
          }

          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => {
            sseBuffer += chunk;
            const parsed = drainSseEvents(sseBuffer);
            sseBuffer = parsed.rest;
            for (const event of parsed.events) {
              if (settled) return;
              handleEvent(event);
            }
          });
          res.on("end", () => {
            if (!settled) {
              settle(() => reject(new Error("SSE stream ended before tools/list response")));
            }
          });
        }
      );

      getReq.on("error", (err) => {
        settle(() => reject(err));
      });
      getReq.on("timeout", () => {
        settle(() => {
          getReq?.destroy();
          reject(new Error("SSE request timed out"));
        });
      });
      getReq.end();
    } catch (err) {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

function drainSseEvents(buffer: string): { events: ParsedSseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: ParsedSseEvent[] = [];
  for (const part of parts) {
    let event = "message";
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice("data:".length).trimStart());
      }
    }
    events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
