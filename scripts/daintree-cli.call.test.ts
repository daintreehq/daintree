import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpDiscoveryFile,
  discoveryProcessStamp,
} from "../electron/services/mcp-server/discoveryFile.js";
import {
  daintreeProfileDir,
  startFakeDaintreeApp,
  stopProcess,
  writeRuntimeFile,
  type FakeDaintreeApp,
} from "../electron/services/mcp-server/__tests__/helpers/fakeDaintreeApp.js";
import {
  NEGOTIATED_VERSION,
  OTHER_TOKEN,
  TOKEN,
  startFixture,
  type Fixture,
} from "./__tests__/helpers/mcpCallFixture.js";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "daintree-cli.sh");

interface CallRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(process.platform === "win32")("daintree call", () => {
  let fixture: Fixture;
  let tmpDir: string;
  /** HOME for each run: the profile a call outside a pane looks in, never the real one. */
  let home: string;
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
        HOME: home,
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
    home = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-call-home-"));
    fixture = await startFixture();
  });

  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    await fixture.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
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
    [{ DAINTREE_MCP_URL: undefined }, "no running Daintree has published"],
    [{ DAINTREE_MCP_TOKEN: undefined }, "DAINTREE_MCP_TOKEN is not set"],
    [{ DAINTREE_MCP_URL: undefined, DAINTREE_MCP_TOKEN: undefined }, "DAINTREE_MCP_URL too"],
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

  // Outside a pane only the key is exported: the port comes from the runtime
  // file the running app publishes, which a crash can leave behind (#17904).
  describe("finding Daintree outside a pane", () => {
    const apps: FakeDaintreeApp[] = [];
    let app: FakeDaintreeApp | null = null;

    afterEach(async () => {
      for (const started of apps.splice(0)) await stopProcess(started.process);
      app = null;
    });

    const fixturePort = () => Number(new URL(fixture.url).port);

    async function startApp(proxyTo = fixturePort(), root = home): Promise<FakeDaintreeApp> {
      const started = await startFakeDaintreeApp(root, { proxyTo });
      apps.push(started);
      return started;
    }

    function publish(from: FakeDaintreeApp, port = from.port) {
      fs.mkdirSync(daintreeProfileDir(home), { recursive: true });
      new McpDiscoveryFile({ dir: () => daintreeProfileDir(home), pid: from.process.pid! }).publish(
        port
      );
      const file = path.join(daintreeProfileDir(home), "mcp-runtime.json");
      return JSON.parse(fs.readFileSync(file, "utf8")) as {
        pid: number;
        port: number;
        startedAt: string;
      };
    }

    /** Publishes as the app does, from a process the CLI takes for it, whose port reaches `proxyTo`. */
    async function publishFromApp(proxyTo = fixturePort()) {
      app = await startApp(proxyTo);
      return publish(app);
    }

    const outsidePane = { DAINTREE_MCP_URL: undefined };

    it("calls the port the running app published, with only the key exported", async () => {
      await publishFromApp();

      const run = await call(["fixture.echo", "--arg", "a=b"], outsidePane);

      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ a: "b" });
      expect(fixture.seen.map((request) => [request.method, request.rpc?.method])).toEqual([
        ["POST", "initialize"],
        ["POST", "notifications/initialized"],
        ["POST", "tools/call"],
        ["DELETE", undefined],
      ]);
    });

    it("goes where DAINTREE_MCP_URL says, whatever the runtime file names", async () => {
      let reached = 0;
      const other = net.createServer((socket) => {
        reached++;
        socket.destroy();
      });
      await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
      try {
        await publishFromApp((other.address() as AddressInfo).port);

        const run = await call(["fixture.echo"]);

        expect(run.status).toBe(0);
        expect(fixture.seen.length).toBeGreaterThan(0);
        expect(reached).toBe(0);
      } finally {
        await new Promise<void>((resolve) => other.close(() => resolve()));
      }
    });

    it("sends nothing when the app that wrote the runtime file has exited", async () => {
      await publishFromApp();
      await stopProcess(app!.process);

      const run = await call(["fixture.echo"], outsidePane);

      expect(run.status).toBe(4);
      expect(run.stderr).toContain("no running Daintree has published");
      expect(fixture.seen).toEqual([]);
    });

    it.each<[string, (record: { pid: number; port: number; startedAt: string }) => unknown]>([
      [
        "names a live process that isn't Daintree",
        (r) => ({ ...r, pid: process.pid, startedAt: discoveryProcessStamp(process.pid) }),
      ],
      ["names the app with another start time", (r) => ({ ...r, startedAt: "Thu Jan 1 1970" })],
      ["has no start time", (r) => ({ pid: r.pid, port: r.port })],
      ["has the port as a string", (r) => ({ ...r, port: String(r.port) })],
      ["has a port out of range", (r) => ({ ...r, port: 65536 + r.port })],
      [
        "has a fractional port",
        (r) => `{"pid":${r.pid},"port":${r.port}.0,"startedAt":"${r.startedAt}"}`,
      ],
      ["has more after the object", (r) => `${JSON.stringify(r)} {}`],
      ["is cut short", (r) => JSON.stringify(r).slice(0, -1)],
    ])("sends nothing when the runtime file %s", async (_name, change) => {
      writeRuntimeFile(home, change(await publishFromApp()));

      const run = await call(["fixture.echo"], outsidePane);

      expect(run.status).toBe(4);
      expect(run.stderr).toContain("no running Daintree has published");
      expect(fixture.seen).toEqual([]);
    });

    // The app is alive and the record its own, but the port is someone else's:
    // a record left standing after the app let the port go.
    it("sends nothing to a port the live app that published it doesn't hold", async () => {
      const holder = await startApp();
      const stranger = await startApp();
      publish(holder, stranger.port);

      const run = await call(["fixture.echo"], outsidePane);

      expect(run.status).toBe(4);
      expect(run.stderr).toContain("no running Daintree has published");
      expect(fixture.seen).toEqual([]);
    });

    it("sends nothing when the runtime file is a link to a record", async () => {
      await publishFromApp();
      const file = path.join(daintreeProfileDir(home), "mcp-runtime.json");
      const real = path.join(home, "elsewhere.json");
      fs.renameSync(file, real);
      fs.symlinkSync(real, file);

      const run = await call(["fixture.echo"], outsidePane);

      expect(run.status).toBe(4);
      expect(fixture.seen).toEqual([]);
    });

    it.each([
      {
        stage: "initialize",
        how: "names another live app",
        message: "while the session was opening",
        reached: ["initialize"],
      },
      {
        stage: "notifications/initialized",
        how: "goes",
        message: "before the call to fixture.echo was sent",
        reached: ["initialize", "notifications/initialized"],
      },
    ])(
      "drops the session, without the call or the close, when the runtime file $how at $stage",
      async ({ stage, message, reached }) => {
        await fixture.close();
        let onStage = () => {};
        fixture = await startFixture({
          onRequest: (method) => {
            if (method === stage) onStage();
          },
        });
        await publishFromApp();
        const file = path.join(daintreeProfileDir(home), "mcp-runtime.json");
        if (stage === "initialize") {
          // A record the client would trust on its own: dropped for not matching.
          const other = await startApp(fixturePort(), path.join(home, "other"));
          onStage = () => publish(other);
        } else {
          onStage = () => fs.rmSync(file);
        }

        const run = await call(["fixture.echo"], outsidePane);

        expect(run.status).toBe(3);
        expect(run.stderr).toContain(message);
        expect(fixture.seen.map((request) => request.rpc?.method)).toEqual(reached);
        expect(fs.readdirSync(tmpDir)).toEqual([]);
      }
    );

    it("opens and ends a held session at the published endpoint too", async () => {
      await publishFromApp();

      const started = await session(["start"], outsidePane);
      expect(started.status).toBe(0);
      const handle = started.stdout.replace(/\n$/, "");
      const held = { ...outsidePane, DAINTREE_MCP_SESSION: handle };
      const called = await call(["fixture.echo", "--arg", "a=b"], held);
      const ended = await session(["end"], held);

      expect(called.status).toBe(0);
      expect(JSON.parse(called.stdout)).toEqual({ a: "b" });
      expect(ended.status).toBe(0);
      expect(fixture.seen.map((request) => request.rpc?.method ?? request.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call",
        "DELETE",
      ]);
      expect(new Set(fixture.seen.slice(1).map((request) => request.sessionId)).size).toBe(1);
    });
  });
});
