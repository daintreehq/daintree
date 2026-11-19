import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "daintree-cli.sh");
const TOKEN = "pane-bearer-1234";
// Valid too, but not the credential that opened the session it is sent with.
const OTHER_TOKEN = "other-bearer-5678";
// The fixture answers initialize with this older revision whatever was asked,
// so a client that sent a constant instead of the negotiated one is refused.
const NEGOTIATED_VERSION = "2025-06-18";

// `daintree call` against the real SDK transport Daintree serves `/mcp` with,
// so the handshake, headers, SSE framing and session teardown are checked
// against what the server actually accepts rather than against a restatement.
interface Seen {
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

interface FixtureOptions {
  jsonResponse?: boolean;
  /** Opens a session for initialize, then sends a reply body that never completes. */
  brokenInitialize?: boolean;
  /** Opens a session for initialize, then closes the connection partway through the body. */
  droppedInitialize?: boolean;
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
}

interface Fixture {
  url: string;
  seen: Seen[];
  sessions: Map<string, StreamableHTTPServerTransport>;
  /** Resolves when the server receives a `tools/call`. */
  callArrived: Promise<void>;
  /** Resolves when the request named by `stall` arrives. */
  stalled: Promise<void>;
  close: () => Promise<void>;
}

async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
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

interface CallRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(process.platform === "win32")("daintree call", () => {
  let fixture: Fixture;
  let tmpDir: string;
  const children = new Set<ChildProcess>();

  function start(
    args: string[],
    env: Record<string, string | undefined> = {},
    stdin?: string | null,
    command = "call"
  ) {
    const child = spawn("bash", [SCRIPT, command, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: tmpDir,
        DAINTREE_MCP_URL: fixture.url,
        DAINTREE_MCP_TOKEN: TOKEN,
        ...env,
      } as NodeJS.ProcessEnv,
    });
    children.add(child);
    // null leaves stdin open, as a terminal would.
    child.stdin.on("error", () => {});
    if (stdin !== null) child.stdin.end(stdin ?? "");
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const done = new Promise<CallRun>((resolve) => {
      child.on("close", (status, signal) => {
        children.delete(child);
        resolve({ status, signal, stdout, stderr });
      });
    });
    return { child, done };
  }

  const call = (args: string[], env?: Record<string, string | undefined>, stdin?: string) =>
    start(args, env, stdin).done;
  const session = (args: string[], env?: Record<string, string | undefined>) =>
    start(args, env, undefined, "session").done;

  /** Opens a held session and returns its handle. */
  async function held(): Promise<string> {
    const run = await session(["start"]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const handle = run.stdout.replace(/\n$/, "");
    expect(handle).not.toContain("\n");
    return handle;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-call-tmp-"));
    fixture = await startFixture();
  });

  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    await fixture.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("makes one call in a session of its own, with the bearer throughout, and closes it", async () => {
    const run = await call(["fixture.echo", "--arg", "terminalId=t-1"]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ terminalId: "t-1" });

    expect(fixture.seen.map((request) => [request.method, request.rpc?.method])).toEqual([
      ["POST", "initialize"],
      ["POST", "notifications/initialized"],
      ["POST", "tools/call"],
      ["DELETE", undefined],
    ]);
    const [initialize, ...rest] = fixture.seen;
    expect(initialize.sessionId).toBeUndefined();
    const sessionId = rest[0].sessionId;
    expect(sessionId).toBeTruthy();
    for (const request of rest) {
      expect(request.sessionId).toBe(sessionId);
      expect(request.protocolVersion).toBe(NEGOTIATED_VERSION);
    }
    expect(fixture.seen[2].rpc?.params?.name).toBe("fixture.echo");
    expect(fixture.seen[2].response).toMatch(/^event: message\ndata: /);
    expect(fixture.sessions.size).toBe(0);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("opens a new session for each call", async () => {
    await call(["fixture.echo"]);
    await call(["fixture.echo"]);
    const initialized = fixture.seen.filter((r) => r.rpc?.method === "notifications/initialized");
    expect(initialized).toHaveLength(2);
    expect(initialized[0].sessionId).not.toBe(initialized[1].sessionId);
    expect(fixture.sessions.size).toBe(0);
  });

  it("carries string values through byte for byte, both ways", async () => {
    const values = {
      quotes: `say "hi" and 'bye'`,
      slashes: "C:\\dir\\n is not a newline \\u0041",
      lines: "one\ntwo\n",
      tab: "a\tb\r\n",
      control: "bell\u0007esc\u001b[0m",
      unicode: "café 😀 ☃",
      empty: "",
      equals: "a=b=c",
      json: '{"isError":true}',
    };
    const args = Object.entries(values).flatMap(([key, value]) => ["--arg", `${key}=${value}`]);

    const run = await call(["fixture.echo", ...args]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(fixture.seen[2].rpc?.params?.arguments).toEqual(values);
    expect(JSON.parse(run.stdout)).toEqual(values);
  });

  it("passes typed arguments from --args unchanged", async () => {
    const typed = { limit: 5, force: true, ids: [1, "a", null], nested: { depth: { ok: false } } };

    const run = await call(["fixture.echo", "--args", JSON.stringify(typed)]);

    expect(run.status).toBe(0);
    expect(fixture.seen[2].rpc?.params?.arguments).toEqual(typed);
  });

  it("reads --args - from stdin, keeping the prompt off the command line", async () => {
    const typed = { prompt: "line one\nline two", wait: true };

    const run = await call(["fixture.echo", "--args", "-"], {}, JSON.stringify(typed));

    expect(run.status).toBe(0);
    expect(fixture.seen[2].rpc?.params?.arguments).toEqual(typed);
  });

  it("prints the whole result with --json", async () => {
    const run = await call(["fixture.echo", "--arg", "a=1", "--json"]);

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      content: [{ type: "text", text: '{"a":"1"}' }],
      structuredContent: { echoed: { a: "1" } },
    });
  });

  it("exits 1 with the tool's own words on stderr when it reports an error", async () => {
    const run = await call(["fixture.refuse"]);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("RESOURCE_NOT_OWNED: not yours\n");
    expect(fixture.sessions.size).toBe(0);

    const asJson = await call(["fixture.refuse", "--json"]);
    expect(asJson.status).toBe(1);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ isError: true });
    expect(asJson.stderr).toBe("RESOURCE_NOT_OWNED: not yours\n");
  });

  it("reads success from the result itself, not from text that looks like an error", async () => {
    const run = await call(["fixture.errorLooking"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('{"isError":true,"error":"only a field"}\n');
  });

  it("prints every text block in order, and the result itself when there is no text", async () => {
    const blocks = await call(["fixture.blocks"]);
    expect(blocks.stdout).toBe("first\nsecond\n");

    const image = await call(["fixture.image"]);
    expect(image.status).toBe(0);
    expect(JSON.parse(image.stdout)).toEqual({
      content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
    });
    expect(image.stderr).toContain("image content not shown");
  });

  it("finds the answer behind a notification on the same stream", async () => {
    const run = await call(["fixture.chatty"]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("done\n");
    const reply = fixture.seen[2].response;
    expect(reply.indexOf("notifications/message")).toBeGreaterThan(-1);
    expect(reply.indexOf("notifications/message")).toBeLessThan(reply.indexOf('"result"'));
  });

  it("exits 1 when Daintree refuses the call before running it", async () => {
    await fixture.close();
    fixture = await startFixture({
      callReply: handshakeRefusal.replace("Start the Assistant again.", "Too large"),
    });

    const run = await call(["fixture.echo"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Too large");
  });

  it("exits 1 when Daintree has no such tool", async () => {
    const run = await call(["fixture.nope"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("fixture.nope");
  });

  it("talks to /mcp when handed an Assistant pane's /sse URL", async () => {
    const run = await call(["fixture.echo"], {
      DAINTREE_MCP_URL: fixture.url.replace(/\/mcp$/, "/sse"),
    });

    expect(run.status).toBe(0);
    expect(new Set(fixture.seen.map((request) => request.path))).toEqual(new Set(["/mcp"]));
  });

  it("sends a localhost URL to 127.0.0.1, the address Daintree binds", async () => {
    const run = await call(["fixture.echo"], {
      DAINTREE_MCP_URL: fixture.url.replace("127.0.0.1", "localhost"),
    });

    expect(run.status).toBe(0);
    const host = new URL(fixture.url).host;
    expect(new Set(fixture.seen.map((request) => request.host))).toEqual(new Set([host]));
  });

  it.each([
    [[], "missing the tool"],
    [["fixture.echo", "--arg", "novalue"], "key=value"],
    [["fixture.echo", "--arg", "=x"], "must be letters"],
    [["fixture.echo", "--arg", "a=1", "--arg", "a=2"], "twice"],
    [["fixture.echo", "--arg", "a=1", "--args", "{}"], "not both"],
    [["fixture.echo", "--args", "[1]"], "one JSON object"],
    [["fixture.echo", "--args", '{"a":'], "one JSON object"],
    [["fixture.echo", "--args", '{"a":1} {"b":2}'], "one JSON object"],
    [["fixture.echo", "--args", '{"a":"\\q"}'], "bad escape"],
    [["fixture.echo", "--args", '{"a":"tab\there"}'], "control character"],
    [["fixture.echo", "other"], "one tool name"],
    [["fixture.echo", "--bogus"], "unknown option"],
  ])("refuses %j before contacting Daintree", async (args, message) => {
    const run = await call(args);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(message);
    expect(fixture.seen).toEqual([]);
  });

  it("reports a usage error before a missing credential", async () => {
    const run = await call(["fixture.echo", "--args", "["], { DAINTREE_MCP_URL: undefined });

    expect(run.status).toBe(2);
  });

  it("reports a usage error without waiting on stdin for --args -", async () => {
    // stdin stays open: a client that read it first would never get to the error.
    const run = await start(["fixture.echo", "--args", "-", "--bogus"], {}, null).done;

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown option");
  });

  it.each([
    [{ DAINTREE_MCP_URL: undefined }, "not set"],
    [{ DAINTREE_MCP_TOKEN: undefined }, "not set"],
    [{ DAINTREE_MCP_URL: "http://example.com:45454/mcp" }, "local endpoint"],
    [{ DAINTREE_MCP_URL: "https://127.0.0.1:45454/mcp" }, "local endpoint"],
    [{ DAINTREE_MCP_URL: "http://127.0.0.1:0/mcp" }, "local endpoint"],
    [{ DAINTREE_MCP_TOKEN: "bad\nInjected: header" }, "malformed"],
  ])(
    "exits 4 without contacting Daintree when the credential is unusable (%j)",
    async (env, message) => {
      const run = await call(["fixture.echo"], env);

      expect(run.status).toBe(4);
      expect(run.stderr).toContain(message);
      expect(fixture.seen).toEqual([]);
    }
  );

  it("exits 4 when Daintree refuses the bearer", async () => {
    const run = await call(["fixture.echo"], { DAINTREE_MCP_TOKEN: "revoked" });

    expect(run.status).toBe(4);
    expect(run.stderr).toContain("401");
    expect(fixture.seen.map((request) => request.rpc?.method)).toEqual(["initialize"]);
  });

  it.each(["notifications/initialized", "tools/call"])(
    "exits 4 when the bearer is refused at %s, and still closes the session",
    async (method) => {
      await fixture.close();
      fixture = await startFixture({ refuse: method });

      const run = await call(["fixture.echo"]);

      expect(run.status).toBe(4);
      expect(run.stderr).toContain("401");
      const last = fixture.seen.at(-1);
      expect(last?.method).toBe("DELETE");
      expect(last?.sessionId).toBe(fixture.seen[1].sessionId);
    }
  );

  it("closes a session whose initialize reply never completed", async () => {
    await fixture.close();
    fixture = await startFixture({ brokenInitialize: true });

    const run = await call(["fixture.echo"]);

    expect(run.status).toBe(3);
    expect(fixture.seen.map((request) => [request.method, request.sessionId])).toEqual([
      ["POST", undefined],
      ["DELETE", "half-open"],
    ]);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("exits 4 for a 401 even when its body is cut short", async () => {
    await fixture.close();
    fixture = await startFixture({ truncatedRefusal: true });

    const run = await call(["fixture.echo"]);

    expect(run.status).toBe(4);
    expect(run.stderr).toContain("401");
  });

  it("closes a session whose initialize connection dropped after its headers", async () => {
    await fixture.close();
    fixture = await startFixture({ droppedInitialize: true });

    const run = await call(["fixture.echo"]);

    expect(run.status).toBe(3);
    expect(fixture.seen.map((request) => [request.method, request.sessionId])).toEqual([
      ["POST", undefined],
      ["DELETE", "dropped"],
    ]);
  });

  const handshakeRefusal = JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32010, message: "Start the Assistant again." },
    id: null,
  });

  // How Daintree's own refusals read, against replies that only look like them.
  it.each([
    ["a refused handshake", { status: 400, body: handshakeRefusal }, 1],
    ["another server's error body", { status: 404, body: '{"error":{"message":"Not found"}}' }, 3],
    [
      "a JSON-RPC error answering initialize, with no session",
      {
        status: 200,
        body: 'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Start the Assistant again."}}\n\n',
      },
      1,
    ],
    [
      "an escaped protocol version",
      {
        status: 200,
        sessionId: "escaped",
        body: 'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25\\u0000"}}\n\n',
      },
      3,
    ],
  ])("reads initialize answered with %s", async (_name, initialize, status) => {
    await fixture.close();
    fixture = await startFixture({ initialize });

    const run = await call(["fixture.echo"]);

    expect(run.status).toBe(status);
    expect(fixture.seen.some((request) => request.rpc?.method === "tools/call")).toBe(false);
    if (status === 1) expect(run.stderr).toContain("Start the Assistant again.");
  });

  it.each([
    [["fixture.refuse"], 1],
    [[], 2],
  ])("exits with its own status for %j when stderr is closed", async (args, status) => {
    const child = spawn("bash", ["-c", 'exec 2>&-; exec bash "$0" call "$@"', SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH,
        TMPDIR: tmpDir,
        DAINTREE_MCP_URL: fixture.url,
        DAINTREE_MCP_TOKEN: TOKEN,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.add(child);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    children.delete(child);

    expect(code).toBe(status);
  });

  const sse = (...events: unknown[]) =>
    events.map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const text = (value: string) => ({ content: [{ type: "text", text: value }] });

  // Replies the SDK would never send, read the way the protocol defines them.
  it.each([
    [
      "an escaped isError key",
      '{"jsonrpc":"2.0","id":2,"result":{"is\\u0045rror":true,"content":[]}}',
      1,
    ],
    [
      "a key that only differs by an escaped control character",
      '{"jsonrpc":"2.0","id":2,"result":{"isError":true,"isError\\u0000":false,"content":[]}}',
      1,
    ],
    ["a null result", sse({ jsonrpc: "2.0", id: 2, result: null }), 3],
    ["no jsonrpc version", sse({ id: 2, result: text("x") }), 3],
    ["only another request's answer", sse({ jsonrpc: "2.0", id: 1, result: text("x") }), 3],
    ["an id written as 2.0", 'data: {"jsonrpc":"2.0","id":2.0,"result":{"content":[]}}\n\n', 0],
    [
      "a JSON-RPC error",
      sse({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad" } }),
      1,
    ],
    [
      "the answer after another id's",
      sse(
        { jsonrpc: "2.0", id: 7, result: text("no") },
        { jsonrpc: "2.0", id: 2, result: text("yes") }
      ),
      0,
      "yes\n",
    ],
  ])("reads a reply with %s", async (_name, reply, status, stdout?: string) => {
    await fixture.close();
    fixture = await startFixture({
      callReply: reply.startsWith("{") ? `event: message\ndata: ${reply}\n\n` : reply,
    });

    const run = await call(["fixture.echo"]);

    expect(run.status).toBe(status);
    if (stdout !== undefined) expect(run.stdout).toBe(stdout);
  });

  it("exits 3 when the connection drops without an answer", async () => {
    const dropping = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => dropping.listen(0, "127.0.0.1", resolve));
    const { port } = dropping.address() as AddressInfo;
    try {
      const run = await call(["fixture.echo"], {
        DAINTREE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      });

      expect(run.status).toBe(3);
      expect(run.stderr).toContain("could not reach Daintree");
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => dropping.close(() => resolve()));
    }
  });

  it("closes the session and its files when stopped mid-call", async () => {
    const { child, done } = start(["fixture.slow"]);
    await fixture.callArrived;
    // The bearer sits in a private directory under the caller's TMPDIR while
    // the call is out.
    const [privateDir] = fs.readdirSync(tmpDir);
    expect(privateDir).toMatch(/^daintree-call\./);
    expect(fs.statSync(path.join(tmpDir, privateDir)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(tmpDir, privateDir, "request-headers")).mode & 0o777).toBe(0o600);

    child.kill("SIGTERM");
    const run = await done;

    expect(run.status).toBe(143);
    expect(fixture.seen.at(-1)?.method).toBe("DELETE");
    expect(fixture.sessions.size).toBe(0);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("reads a plain JSON reply as well as an SSE stream", async () => {
    await fixture.close();
    fixture = await startFixture({ jsonResponse: true });

    const run = await call(["fixture.echo", "--arg", "a=b"]);

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ a: "b" });
    expect(fixture.seen[2].response.startsWith("{")).toBe(true);
    expect(fixture.sessions.size).toBe(0);
  });

  describe("held session", () => {
    const sessionOf = (handle: string) => {
      const opened = fixture.seen.find((r) => r.rpc?.method === "notifications/initialized");
      expect(opened?.sessionId).toBeTruthy();
      expect(handle).toBe(`${NEGOTIATED_VERSION}:${opened?.sessionId}`);
      return opened?.sessionId ?? "";
    };

    it("lets a later process drive what an earlier one launched, where one-shot calls can't", async () => {
      expect((await call(["fixture.launch", "--arg", "terminalId=t-0"])).status).toBe(0);
      const oneShot = await call(["fixture.send", "--arg", "terminalId=t-0"]);
      expect(oneShot.status).toBe(1);
      expect(oneShot.stderr).toContain("RESOURCE_NOT_OWNED");
      fixture.seen.length = 0;

      const handle = await held();
      expect(handle).not.toContain(TOKEN);
      const sessionId = sessionOf(handle);
      const env = { DAINTREE_MCP_SESSION: handle };

      const launched = await call(["fixture.launch", "--arg", "terminalId=t-1", "--json"], env);
      expect(launched.stderr).toBe("");
      expect(launched.status).toBe(0);
      expect(JSON.parse(launched.stdout)).toEqual({
        content: [{ type: "text", text: "launched t-1" }],
      });
      const sent = await call(["fixture.send", "--arg", "terminalId=t-1"], env);
      expect(sent.stderr).toBe("");
      expect(sent.status).toBe(0);
      expect(sent.stdout).toBe("sent to t-1\n");

      expect(fixture.seen.map((request) => [request.method, request.rpc?.method])).toEqual([
        ["POST", "initialize"],
        ["POST", "notifications/initialized"],
        ["POST", "tools/call"],
        ["POST", "tools/call"],
      ]);
      const calls = fixture.seen.filter((request) => request.rpc?.method === "tools/call");
      for (const request of calls) {
        expect(request.sessionId).toBe(sessionId);
        expect(request.protocolVersion).toBe(NEGOTIATED_VERSION);
        expect(Number.isSafeInteger(request.rpc?.id)).toBe(true);
        expect(request.rpc?.id).not.toBe(fixture.seen[0].rpc?.id);
      }
      expect(calls[0].rpc?.id).not.toBe(calls[1].rpc?.id);
      // Held open between calls, and nothing left on disk by any of them.
      expect(fixture.sessions.size).toBe(1);
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    });

    it("gives concurrent calls in one session different ids", async () => {
      const env = { DAINTREE_MCP_SESSION: await held() };

      const runs = await Promise.all(
        Array.from({ length: 4 }, (_, i) => call(["fixture.echo", "--arg", `n=${i}`], env))
      );

      expect(runs.map((run) => run.status)).toEqual([0, 0, 0, 0]);
      expect(runs.map((run) => JSON.parse(run.stdout))).toEqual(
        Array.from({ length: 4 }, (_, i) => ({ n: String(i) }))
      );
      const ids = fixture.seen
        .filter((request) => request.rpc?.method === "tools/call")
        .map((request) => request.rpc?.id);
      expect(new Set(ids).size).toBe(4);
    });

    it("ends the session, after which its handle fails with its own status", async () => {
      const handle = await held();
      const sessionId = sessionOf(handle);

      const ended = await session(["end"], { DAINTREE_MCP_SESSION: handle });

      expect(ended.stderr).toBe("");
      expect(ended.status).toBe(0);
      const last = fixture.seen.at(-1);
      expect(last?.method).toBe("DELETE");
      expect(last?.sessionId).toBe(sessionId);
      expect(last?.protocolVersion).toBe(NEGOTIATED_VERSION);
      expect(fixture.sessions.size).toBe(0);

      const after = await call(["fixture.echo"], { DAINTREE_MCP_SESSION: handle });
      expect(after.status).toBe(5);
      expect(after.stderr).toContain("DAINTREE_MCP_SESSION");
      const again = await session(["end"], { DAINTREE_MCP_SESSION: handle });
      expect(again.status).toBe(5);
      expect(fixture.seen.filter((request) => request.rpc?.method === "initialize")).toHaveLength(
        1
      );
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    });

    it("fails a handle whose session has gone, without opening another", async () => {
      const handle = await held();
      const sessionId = sessionOf(handle);
      // As the server's idle reaper, a listener stop or a key rotation would.
      await fixture.sessions.get(sessionId)?.close();
      fixture.seen.length = 0;

      const run = await call(["fixture.launch", "--arg", "terminalId=t-1"], {
        DAINTREE_MCP_SESSION: handle,
      });

      expect(run.status).toBe(5);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("session start");
      expect(fixture.seen.map((request) => [request.method, request.rpc?.method])).toEqual([
        ["POST", "tools/call"],
      ]);
      expect(fixture.sessions.size).toBe(0);

      const ended = await session(["end"], { DAINTREE_MCP_SESSION: handle });
      expect(ended.status).toBe(5);
    });

    it("leaves the session open when a held call is stopped mid-call", async () => {
      const handle = await held();
      const { child, done } = start(["fixture.slow"], { DAINTREE_MCP_SESSION: handle });
      await fixture.callArrived;

      child.kill("SIGTERM");
      const run = await done;

      expect(run.status).toBe(143);
      expect(fixture.seen.some((request) => request.method === "DELETE")).toBe(false);
      expect(fixture.sessions.size).toBe(1);
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    });

    it("exits 4 when Daintree refuses the bearer on a held call", async () => {
      const handle = await held();

      const run = await call(["fixture.echo"], {
        DAINTREE_MCP_SESSION: handle,
        DAINTREE_MCP_TOKEN: "rotated",
      });

      expect(run.status).toBe(4);
      expect(fixture.seen.some((request) => request.method === "DELETE")).toBe(false);
    });

    it("takes a 200 to end as ended even when its reply is cut short", async () => {
      await fixture.close();
      fixture = await startFixture({ truncatedDelete: true });
      const handle = await held();

      const run = await session(["end"], { DAINTREE_MCP_SESSION: handle });

      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(fixture.sessions.size).toBe(0);
    });

    it("exits 4 when Daintree refuses the bearer on end, leaving the session open", async () => {
      const handle = await held();

      const run = await session(["end"], {
        DAINTREE_MCP_SESSION: handle,
        DAINTREE_MCP_TOKEN: "rotated",
      });

      expect(run.status).toBe(4);
      expect(fixture.sessions.size).toBe(1);
    });

    it("fails a handle sent with another credential, leaving the session to its own", async () => {
      const handle = await held();
      const sessionId = sessionOf(handle);
      const foreign = { DAINTREE_MCP_SESSION: handle, DAINTREE_MCP_TOKEN: OTHER_TOKEN };

      const run = await call(["fixture.launch", "--arg", "terminalId=t-1"], foreign);
      expect(run.status).toBe(5);
      const ended = await session(["end"], foreign);
      expect(ended.status).toBe(5);

      expect(fixture.sessions.has(sessionId)).toBe(true);
      expect(fixture.seen.filter((r) => r.rpc?.method === "initialize")).toHaveLength(1);
      expect(fixture.seen.filter((r) => r.rpc?.method === "tools/call")).toHaveLength(1);
      const own = await call(["fixture.echo"], { DAINTREE_MCP_SESSION: handle });
      expect(own.status).toBe(0);
    });

    it("closes the session when stopped while start is opening it", async () => {
      await fixture.close();
      fixture = await startFixture({ stall: "notifications/initialized" });

      const { child, done } = start(["start"], {}, undefined, "session");
      await fixture.stalled;
      child.kill("SIGTERM");
      const run = await done;

      expect(run.status).toBe(143);
      expect(run.stdout).toBe("");
      expect(fixture.seen.at(-1)).toMatchObject({
        method: "DELETE",
        sessionId: fixture.seen[1].sessionId,
      });
      expect(fixture.sessions.size).toBe(0);
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    });

    it("closes a session it opened but couldn't hand over", async () => {
      await fixture.close();
      fixture = await startFixture({ refuse: "notifications/initialized" });

      const refused = await session(["start"]);
      expect(refused.status).toBe(4);
      expect(refused.stdout).toBe("");
      expect(fixture.seen.at(-1)).toMatchObject({
        method: "DELETE",
        sessionId: fixture.seen[1].sessionId,
      });
      expect(fixture.sessions.size).toBe(0);

      // stdout closed: the handle can't reach the script, so the session closes.
      await fixture.close();
      fixture = await startFixture();
      const child = spawn("bash", ["-c", 'exec 1>&-; exec bash "$0" session start', SCRIPT], {
        env: {
          PATH: process.env.PATH,
          TMPDIR: tmpDir,
          DAINTREE_MCP_URL: fixture.url,
          DAINTREE_MCP_TOKEN: TOKEN,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.add(child);
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      children.delete(child);
      expect(code).toBe(3);
      expect(fixture.seen.at(-1)?.method).toBe("DELETE");
      expect(fixture.sessions.size).toBe(0);
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    });

    it.each([
      [[], "start or end"],
      [["bogus"], "start or end"],
      [["start", "extra"], "start or end"],
      [["end", "extra"], "start or end"],
    ])("refuses session %j before contacting Daintree", async (args, message) => {
      const run = await session(args);

      expect(run.status).toBe(2);
      expect(run.stderr).toContain(message);
      expect(fixture.seen).toEqual([]);
    });

    it.each([
      [["end"], { DAINTREE_MCP_SESSION: undefined }],
      [["end"], { DAINTREE_MCP_SESSION: "" }],
      [["end"], { DAINTREE_MCP_SESSION: "no-version" }],
      // Replacing a held session would leave it open with no handle to end it.
      [["start"], { DAINTREE_MCP_SESSION: `${NEGOTIATED_VERSION}:held` }],
    ])("refuses session %j with %j before contacting Daintree", async (args, env) => {
      const run = await session(args, env);

      expect(run.status).toBe(2);
      expect(run.stderr).toContain("DAINTREE_MCP_SESSION");
      expect(fixture.seen).toEqual([]);
    });

    it.each(["no-version", "2025-06-18:", ":abc", "2025-06-18:has space", "v 1:abc"])(
      "refuses a malformed handle %j before contacting Daintree",
      async (handle) => {
        const run = await call(["fixture.echo"], { DAINTREE_MCP_SESSION: handle });

        expect(run.status).toBe(2);
        expect(run.stderr).toContain("DAINTREE_MCP_SESSION");
        expect(fixture.seen).toEqual([]);
      }
    );

    it("makes a one-shot call when the handle is empty", async () => {
      const run = await call(["fixture.echo"], { DAINTREE_MCP_SESSION: "" });

      expect(run.status).toBe(0);
      expect(fixture.seen.map((request) => request.method)).toEqual([
        "POST",
        "POST",
        "POST",
        "DELETE",
      ]);
    });

    it("needs the credential to start", async () => {
      const run = await session(["start"], { DAINTREE_MCP_TOKEN: undefined });

      expect(run.status).toBe(4);
      expect(fixture.seen).toEqual([]);
    });

    it("explains itself with --help", async () => {
      const run = await session(["--help"]);

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("Usage: daintree session start");
      expect(fixture.seen).toEqual([]);
    });
  });
});
