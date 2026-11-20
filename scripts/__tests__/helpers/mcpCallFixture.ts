import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

export const TOKEN = "pane-bearer-1234";
// Valid too, but not the credential that opened the session it is sent with.
export const OTHER_TOKEN = "other-bearer-5678";
// The fixture answers initialize with this older revision whatever was asked,
// so a client that sent a constant instead of the negotiated one is refused.
export const NEGOTIATED_VERSION = "2025-06-18";

// `daintree call` against the real SDK transport Daintree serves `/mcp` with,
// so the handshake, headers, SSE framing and session teardown are checked
// against what the server actually accepts rather than against a restatement.
export interface Seen {
  method: string;
  path: string;
  host: string | undefined;
  sessionId: string | undefined;
  protocolVersion: string | undefined;
  rpc:
    { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } } | undefined;
  /** What the server wrote back, as sent. */
  response: string;
}

export interface FixtureOptions {
  jsonResponse?: boolean;
  /** Opens a session for initialize, then sends a reply body that never completes. */
  brokenInitialize?: boolean;
  /** Opens a session for initialize, then closes the connection partway through the body. */
  droppedInitialize?: boolean;
  /** Opens a session for initialize, sends its headers, then holds the body until the fixture closes. */
  stalledInitialize?: boolean;
  /** Refuses initialize with a 401 whose body is cut short. */
  truncatedRefusal?: boolean;
  /** Answers initialize with this instead of opening a session. */
  initialize?: { status: number; body: string; sessionId?: string };
  /** Answers tools/call with this body as an SSE stream instead of running a tool. */
  callReply?: string;
  /** Answers this JSON-RPC method with a 401, as for a bearer revoked mid-call. */
  refuse?: string;
  /** Holds this JSON-RPC method's request unanswered until the fixture closes. */
  stall?: string;
  /** Closes the session a DELETE names, then cuts its 200 short. */
  truncatedDelete?: boolean;
  /** Runs as each request arrives, before it is answered. */
  onRequest?: (rpcMethod: string | undefined) => void;
}

export interface Fixture {
  url: string;
  seen: Seen[];
  sessions: Map<string, StreamableHTTPServerTransport>;
  /** Resolves when the server receives a `tools/call`. */
  callArrived: Promise<void>;
  /** Resolves when the request named by `stall` arrives, or initialize's headers under `stalledInitialize` are out. */
  stalled: Promise<void>;
  close: () => Promise<void>;
}

export async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const seen: Seen[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let signalCall: () => void = () => {};
  const callArrived = new Promise<void>((resolve) => {
    signalCall = resolve;
  });
  let signalStalled: () => void = () => {};
  const stalled = new Promise<void>((resolve) => {
    signalStalled = resolve;
  });
  const openedWith = new Map<string, string | undefined>();
  let releaseSlow: () => void = () => {};
  const slowReleased = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });

  // What each MCP session created, as the server records it for an api key:
  // the session, not the bearer, holds the authority.
  const owned = new Map<string, Set<unknown>>();

  const tools: Record<
    string,
    (
      args: Record<string, unknown>,
      notify: () => Promise<void>,
      sessionId: string | undefined
    ) => Promise<CallToolResult>
  > = {
    "fixture.echo": async (args) => ({
      content: [{ type: "text", text: JSON.stringify(args) }],
      structuredContent: { echoed: args },
    }),
    "fixture.refuse": async () => ({
      isError: true,
      content: [{ type: "text", text: "RESOURCE_NOT_OWNED: not yours" }],
    }),
    "fixture.errorLooking": async () => ({
      content: [{ type: "text", text: '{"isError":true,"error":"only a field"}' }],
    }),
    "fixture.blocks": async () => ({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    }),
    "fixture.image": async () => ({
      content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
    }),
    "fixture.chatty": async (_args, notify) => {
      await notify();
      return { content: [{ type: "text", text: "done" }] };
    },
    "fixture.slow": async () => {
      await slowReleased;
      return { content: [{ type: "text", text: "late" }] };
    },
    "fixture.launch": async (args, _notify, sessionId) => {
      if (sessionId === undefined) throw new Error("no session");
      const ids = owned.get(sessionId) ?? new Set<unknown>();
      ids.add(args.terminalId);
      owned.set(sessionId, ids);
      return { content: [{ type: "text", text: `launched ${String(args.terminalId)}` }] };
    },
    "fixture.send": async (args, _notify, sessionId) =>
      sessionId !== undefined && owned.get(sessionId)?.has(args.terminalId)
        ? { content: [{ type: "text", text: `sent to ${String(args.terminalId)}` }] }
        : { isError: true, content: [{ type: "text", text: "RESOURCE_NOT_OWNED: not yours" }] },
  };

  const newSessionServer = () => {
    const server = new Server(
      { name: "daintree-fixture", version: "1.0.0" },
      { capabilities: { tools: {}, logging: {} } }
    );
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = tools[request.params.name];
      if (!tool)
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
      return tool(
        request.params.arguments ?? {},
        () =>
          extra.sendNotification({
            method: "notifications/message",
            params: { level: "info", data: "working" },
          }),
        extra.sessionId
      );
    });
    return server;
  };

  const httpServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let rpc: Seen["rpc"];
    try {
      rpc = raw ? JSON.parse(raw) : undefined;
    } catch {
      rpc = undefined;
    }
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const entry: Seen = {
      method: req.method ?? "",
      path: req.url ?? "",
      host: header("host"),
      sessionId: header("mcp-session-id"),
      protocolVersion: header("mcp-protocol-version"),
      rpc,
      response: "",
    };
    seen.push(entry);
    options.onRequest?.(rpc?.method);
    if (rpc?.method === "tools/call") signalCall();

    const capture = (chunk: unknown) => {
      if (chunk === undefined || typeof chunk === "function") return chunk;
      let text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
      if (rpc?.method === "initialize") {
        text = text.replace(
          /"protocolVersion":"[^"]*"/,
          `"protocolVersion":"${NEGOTIATED_VERSION}"`
        );
      }
      entry.response += text;
      return text;
    };
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
    res.write = ((chunk: unknown, ...rest: unknown[]) =>
      write(capture(chunk), ...rest)) as typeof res.write;
    res.end = ((chunk?: unknown, ...rest: unknown[]) =>
      end(capture(chunk), ...rest)) as typeof res.end;

    const authorization = req.headers.authorization;
    if (
      (authorization !== `Bearer ${TOKEN}` && authorization !== `Bearer ${OTHER_TOKEN}`) ||
      (options.refuse !== undefined && rpc?.method === options.refuse)
    ) {
      res.writeHead(401, { "Content-Type": "text/plain" }).end("Unauthorized");
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    // Fewer bytes than the declared length, then the end of the connection once
    // they are on the wire: curl has the headers and fails the transfer.
    const cutShort = (status: number, headers: Record<string, string>) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": "100",
        ...headers,
      });
      res.write('{"jsonrpc":', () => res.socket?.end());
    };
    if (options.droppedInitialize && rpc?.method === "initialize") {
      cutShort(200, { "Mcp-Session-Id": "dropped" });
      return;
    }
    if (options.truncatedRefusal && rpc?.method === "initialize") {
      cutShort(401, {});
      return;
    }
    if (options.initialize && rpc?.method === "initialize") {
      const { status, body, sessionId: id } = options.initialize;
      res
        .writeHead(status, {
          "Content-Type": body.startsWith("{") ? "application/json" : "text/event-stream",
          ...(id ? { "Mcp-Session-Id": id } : {}),
        })
        .end(body);
      return;
    }
    if (options.callReply !== undefined && rpc?.method === "tools/call") {
      const status = options.callReply.startsWith("{") ? 413 : 200;
      res.writeHead(status, { "Content-Type": "text/event-stream" }).end(options.callReply);
      return;
    }
    if (options.stalledInitialize && rpc?.method === "initialize") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "stalled" });
      res.flushHeaders();
      signalStalled();
      await slowReleased;
      res.destroy();
      return;
    }
    if (options.brokenInitialize && rpc?.method === "initialize") {
      res
        .writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "half-open" })
        .end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":\n\n');
      return;
    }
    const closing =
      req.method === "DELETE" ? sessions.get(header("mcp-session-id") ?? "") : undefined;
    if (options.truncatedDelete && closing) {
      await closing.close();
      cutShort(200, {});
      return;
    }
    if (options.stall !== undefined && rpc?.method === options.stall) {
      signalStalled();
      await slowReleased;
      res.destroy();
      return;
    }
    const sessionId = header("mcp-session-id");
    let transport = sessionId ? sessions.get(sessionId) : undefined;
    // As Daintree does, one answer for an unknown session and for one another
    // credential opened.
    if (sessionId && (!transport || openedWith.get(sessionId) !== authorization)) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        })
      );
      return;
    }
    if (!transport) {
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: options.jsonResponse === true,
        onsessioninitialized: (id) => {
          sessions.set(id, created);
          openedWith.set(id, authorization);
        },
      });
      created.onclose = () => {
        if (created.sessionId) sessions.delete(created.sessionId);
      };
      await newSessionServer().connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, rpc);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    sessions,
    callArrived,
    stalled,
    close: async () => {
      releaseSlow();
      for (const transport of sessions.values()) await transport.close().catch(() => {});
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
