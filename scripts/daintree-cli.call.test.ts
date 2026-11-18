import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
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

// `daintree call` against the real SDK transport Daintree serves `/mcp` with,
// so the handshake, headers, SSE framing and session teardown are checked
// against what the server actually accepts rather than against a restatement.
interface Seen {
  method: string;
  path: string;
  sessionId: string | undefined;
  protocolVersion: string | undefined;
  rpc: { method?: string; params?: { name?: string; arguments?: unknown } } | undefined;
}

interface Fixture {
  url: string;
  seen: Seen[];
  sessions: Map<string, StreamableHTTPServerTransport>;
  /** Resolves when the server receives a `tools/call`. */
  callArrived: Promise<void>;
  close: () => Promise<void>;
}

async function startFixture(options: { jsonResponse?: boolean } = {}): Promise<Fixture> {
  const seen: Seen[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let signalCall: () => void = () => {};
  const callArrived = new Promise<void>((resolve) => {
    signalCall = resolve;
  });
  let releaseSlow: () => void = () => {};
  const slowReleased = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });

  const tools: Record<
    string,
    (args: Record<string, unknown>, notify: () => Promise<void>) => Promise<CallToolResult>
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
      return tool(request.params.arguments ?? {}, () =>
        extra.sendNotification({
          method: "notifications/message",
          params: { level: "info", data: "working" },
        })
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
    seen.push({
      method: req.method ?? "",
      path: req.url ?? "",
      sessionId: header("mcp-session-id"),
      protocolVersion: header("mcp-protocol-version"),
      rpc,
    });
    if (rpc?.method === "tools/call") signalCall();

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "Content-Type": "text/plain" }).end("Unauthorized");
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const sessionId = header("mcp-session-id");
    let transport = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !transport) {
      res
        .writeHead(404, { "Content-Type": "application/json" })
        .end(
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

  function start(args: string[], env: Record<string, string | undefined> = {}) {
    const child = spawn("bash", [SCRIPT, "call", ...args], {
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

  const call = (args: string[], env?: Record<string, string | undefined>) => start(args, env).done;

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
      expect(request.protocolVersion).toBeTruthy();
    }
    expect(fixture.seen[2].rpc?.params?.name).toBe("fixture.echo");
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

  it.each([
    [[], "missing the tool"],
    [["fixture.echo", "--arg", "novalue"], "key=value"],
    [["fixture.echo", "--arg", "=x"], "must be letters"],
    [["fixture.echo", "--arg", "a=1", "--arg", "a=2"], "twice"],
    [["fixture.echo", "--arg", "a=1", "--args", "{}"], "not both"],
    [["fixture.echo", "--args", "[1]"], "one JSON object"],
    [["fixture.echo", "--args", '{"a":'], "one JSON object"],
    [["fixture.echo", "--args", '{"a":1} {"b":2}'], "one JSON object"],
    [["fixture.echo", "other"], "one tool name"],
    [["fixture.echo", "--bogus"], "unknown option"],
  ])("refuses %j before contacting Daintree", async (args, message) => {
    const run = await call(args);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(message);
    expect(fixture.seen).toEqual([]);
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

  it("exits 3 when nothing is listening", async () => {
    const url = fixture.url;
    await fixture.close();
    fixture = await startFixture();

    const run = await call(["fixture.echo"], { DAINTREE_MCP_URL: url });

    expect(run.status).toBe(3);
    expect(run.stderr).toContain("could not reach Daintree");
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("closes the session and its files when stopped mid-call", async () => {
    const { child, done } = start(["fixture.slow"]);
    await fixture.callArrived;

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
    expect(fixture.sessions.size).toBe(0);
  });
});
