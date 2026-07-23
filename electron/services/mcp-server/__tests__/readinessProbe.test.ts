import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROBE_BASE_DELAY_MS,
  PROBE_MAX_ATTEMPTS,
  PROBE_PROTOCOL_VERSION,
  PROBE_SSE_HARD_TIMEOUT_MS,
  PROBE_SSE_REQUEST_TIMEOUT_MS,
  probeMcpServer,
  probeMcpSseServer,
} from "../readinessProbe.js";
import { ACTIONS_LIST_TOOL } from "../shared.js";

interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface FakeServer {
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function startFakeServer(handler: Handler): Promise<FakeServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
      });
      handler(req, res, body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("failed to bind fake server");
  }

  return {
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe("probeMcpServer", () => {
  let fake: FakeServer | null = null;

  afterEach(async () => {
    if (fake) {
      await fake.close();
      fake = null;
    }
  });

  it("resolves when the server responds 200 with mcp-session-id and sends DELETE cleanup", async () => {
    const sessionId = "test-session-id-12345";
    fake = await startFakeServer((req, res) => {
      if (req.method === "POST" && req.url === "/mcp") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "mcp-session-id": sessionId,
        });
        // Flush headers without ending — mimic a long-lived SSE stream.
        // The probe should destroy the request after reading headers.
        res.flushHeaders();
        return;
      }
      if (req.method === "DELETE" && req.url === "/mcp") {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await probeMcpServer(fake.port, "test-api-key");

    // POST happened first
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toBe("/mcp");
    expect(fake.requests[0]?.headers.authorization).toBe("Bearer test-api-key");
    const parsed = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(parsed.method).toBe("initialize");
    expect(parsed.params.protocolVersion).toBe(PROBE_PROTOCOL_VERSION);
    expect(parsed.params.clientInfo.name).toBe("daintree-readiness-probe");

    // Wait briefly for cleanup DELETE to land — it's fire-and-await but
    // the server might still be writing.
    await new Promise((r) => setTimeout(r, 50));
    const deleteReq = fake.requests.find((r) => r.method === "DELETE");
    expect(deleteReq).toBeDefined();
    expect(deleteReq?.headers["mcp-session-id"]).toBe(sessionId);
    expect(deleteReq?.headers.authorization).toBe("Bearer test-api-key");
  });

  it("rejects when the server returns 401", async () => {
    fake = await startFakeServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
    });

    await expect(probeMcpServer(fake.port, "wrong-key", { hardTimeoutMs: 500 })).rejects.toThrow(
      /status 401/
    );
  });

  it("rejects after retries when the server consistently returns 500", async () => {
    fake = await startFakeServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });

    await expect(
      probeMcpServer(fake.port, "test-api-key", { hardTimeoutMs: 500, baseDelayMs: 10 })
    ).rejects.toThrow(/MCP readiness probe failed after \d+ attempt/);

    expect(fake.requests.filter((r) => r.method === "POST").length).toBeGreaterThanOrEqual(2);
  });

  it("rejects when the response is missing the mcp-session-id header", async () => {
    fake = await startFakeServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });

    await expect(
      probeMcpServer(fake.port, "test-api-key", { hardTimeoutMs: 500, baseDelayMs: 10 })
    ).rejects.toThrow(/missing mcp-session-id/);
  });

  it("rejects when the port is not listening (connection refused)", async () => {
    // Use a port we know is closed — bind and immediately release.
    const tmp = http.createServer();
    await new Promise<void>((resolve) => tmp.listen(0, "127.0.0.1", () => resolve()));
    const address = tmp.address();
    if (typeof address !== "object" || address === null) throw new Error("bind failed");
    const closedPort = address.port;
    await new Promise<void>((resolve) => tmp.close(() => resolve()));

    await expect(
      probeMcpServer(closedPort, "test-api-key", { hardTimeoutMs: 500, baseDelayMs: 10 })
    ).rejects.toThrow(/MCP readiness probe failed/);
  });

  it("treats DELETE cleanup failures as non-fatal", async () => {
    let postCount = 0;
    fake = await startFakeServer((req, res) => {
      if (req.method === "POST") {
        postCount++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "mcp-session-id": "sess-1",
        });
        res.flushHeaders();
        return;
      }
      // DELETE — close the socket abruptly to simulate failure
      res.destroy();
    });

    await expect(probeMcpServer(fake.port, "test-api-key")).resolves.toBeUndefined();
    expect(postCount).toBe(1);
  });

  it("retries with exponential backoff up to maxAttempts on transient failures", async () => {
    let attempts = 0;
    fake = await startFakeServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(200);
        res.end();
        return;
      }
      attempts++;
      if (attempts < 2) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "mcp-session-id": "recovered",
      });
      // Flush headers, but don't end (SSE stream) — probe destroys after headers
      res.flushHeaders();
    });

    await probeMcpServer(fake.port, "test-api-key", { baseDelayMs: 10 });
    expect(attempts).toBe(2);
  });

  it("respects the hard timeout", async () => {
    fake = await startFakeServer((_req, res) => {
      // Hang forever — never respond. The per-request timeout will
      // eventually destroy the request, but the hard timeout should
      // bound the entire probe.
      void res;
    });

    const start = Date.now();
    await expect(
      probeMcpServer(fake.port, "test-api-key", {
        hardTimeoutMs: 200,
        requestTimeoutMs: 80,
        baseDelayMs: 10,
      })
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Hard timeout caps the loop. Generous CI slack but not so loose
    // that a regression to "no hard timeout" would pass.
    expect(elapsed).toBeLessThan(800);
  });

  it("logs a warning when DELETE cleanup returns non-2xx (still resolves)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fake = await startFakeServer((req, res) => {
      if (req.method === "POST") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "mcp-session-id": "doomed",
        });
        res.flushHeaders();
        return;
      }
      // DELETE returns 404 — server says "no such session" — non-fatal
      // but should be logged so operators can see something is off.
      res.writeHead(404);
      res.end();
    });

    await probeMcpServer(fake.port, "test-api-key");
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Readiness probe cleanup DELETE failed"),
        expect.objectContaining({ message: expect.stringContaining("status 404") })
      )
    );
    warn.mockRestore();
  });
});

describe("probeMcpSseServer", () => {
  let fake: FakeServer | null = null;

  afterEach(async () => {
    if (fake) {
      await fake.close();
      fake = null;
    }
  });

  it("resolves after SSE endpoint discovery, initialize, and manifest-backed tools/list", async () => {
    let sseRes: http.ServerResponse | null = null;
    fake = await startFakeServer((req, res, body) => {
      if (req.method === "GET" && req.url === "/sse") {
        sseRes = res;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("event: endpoint\ndata: /messages?sessionId=sse-session-1\n\n");
        return;
      }
      if (req.method === "POST" && req.url === "/messages?sessionId=sse-session-1") {
        const parsed = JSON.parse(body);
        res.writeHead(202);
        res.end("Accepted");
        if (parsed.method === "initialize") {
          expect(parsed.params.protocolVersion).toBe(PROBE_PROTOCOL_VERSION);
          sseRes?.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: PROBE_PROTOCOL_VERSION,
                capabilities: {},
                serverInfo: { name: "fake", version: "1.0.0" },
              },
            })}\n\n`
          );
          return;
        }
        if (parsed.method === "tools/list") {
          sseRes?.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: {
                tools: [
                  {
                    name: ACTIONS_LIST_TOOL,
                    description: "List available Daintree actions",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              },
            })}\n\n`
          );
          return;
        }
        throw new Error(`unexpected method ${String(parsed.method)}`);
      }
      res.writeHead(404);
      res.end();
    });

    await probeMcpSseServer(fake.port, "help-token");

    const getReq = fake.requests.find((r) => r.method === "GET");
    expect(getReq?.path).toBe("/sse");
    expect(getReq?.headers.authorization).toBe("Bearer help-token");

    const postReqs = fake.requests.filter((r) => r.method === "POST");
    expect(postReqs).toHaveLength(2);
    expect(postReqs.map((r) => JSON.parse(r.body).method)).toEqual(["initialize", "tools/list"]);
    expect(postReqs.every((r) => r.path === "/messages?sessionId=sse-session-1")).toBe(true);
    expect(postReqs.every((r) => r.headers.authorization === "Bearer help-token")).toBe(true);
  });

  it("rejects when the SSE endpoint returns 401", async () => {
    fake = await startFakeServer((_req, res) => {
      res.writeHead(401);
      res.end("Unauthorized");
    });

    await expect(
      probeMcpSseServer(fake.port, "bad-token", { hardTimeoutMs: 500, baseDelayMs: 10 })
    ).rejects.toThrow(/SSE returned status 401/);
  });

  it("rejects when tools/list does not include the renderer-backed action manifest tool", async () => {
    let sseRes: http.ServerResponse | null = null;
    fake = await startFakeServer((req, res, body) => {
      if (req.method === "GET" && req.url === "/sse") {
        sseRes = res;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("event: endpoint\ndata: /messages?sessionId=sse-session-missing-tool\n\n");
        return;
      }
      if (req.method === "POST" && req.url === "/messages?sessionId=sse-session-missing-tool") {
        const parsed = JSON.parse(body);
        res.writeHead(202);
        res.end("Accepted");
        if (parsed.method === "initialize") {
          sseRes?.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: PROBE_PROTOCOL_VERSION,
                capabilities: {},
                serverInfo: { name: "fake", version: "1.0.0" },
              },
            })}\n\n`
          );
          return;
        }
        if (parsed.method === "tools/list") {
          sseRes?.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: { tools: [{ name: "terminal.waitUntilIdle" }] },
            })}\n\n`
          );
          return;
        }
      }
      res.writeHead(404);
      res.end();
    });

    await expect(
      probeMcpSseServer(fake.port, "help-token", { hardTimeoutMs: 500, baseDelayMs: 10 })
    ).rejects.toThrow(/actions\.list/);
  });

  it("rejects when the SSE stream never returns tools/list response", async () => {
    let sseRes: http.ServerResponse | null = null;
    fake = await startFakeServer((req, res, body) => {
      if (req.method === "GET" && req.url === "/sse") {
        sseRes = res;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("event: endpoint\ndata: /messages?sessionId=sse-session-2\n\n");
        return;
      }
      if (req.method === "POST" && req.url === "/messages?sessionId=sse-session-2") {
        const parsed = JSON.parse(body);
        res.writeHead(202);
        res.end("Accepted");
        if (parsed.method === "initialize") {
          sseRes?.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: PROBE_PROTOCOL_VERSION,
                capabilities: {},
                serverInfo: { name: "fake", version: "1.0.0" },
              },
            })}\n\n`
          );
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await expect(
      probeMcpSseServer(fake.port, "help-token", {
        hardTimeoutMs: 250,
        requestTimeoutMs: 80,
        baseDelayMs: 10,
      })
    ).rejects.toThrow(/MCP SSE readiness probe failed/);
  });
});

describe("probe constants", () => {
  it("exports sane defaults", () => {
    expect(PROBE_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(PROBE_BASE_DELAY_MS).toBeGreaterThan(0);
    expect(PROBE_SSE_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    expect(PROBE_SSE_HARD_TIMEOUT_MS).toBeGreaterThan(PROBE_SSE_REQUEST_TIMEOUT_MS);
  });
});
