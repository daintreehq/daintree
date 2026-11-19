import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NEGOTIATED_VERSION,
  OTHER_TOKEN,
  TOKEN,
  startFixture,
  type Fixture,
} from "./__tests__/helpers/mcpCallFixture.js";
import { WINDOWS_CLI_TEMPLATE, renderWindowsCliShim } from "./afterPack.cjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "daintree-call.ps1");

// `daintree call` on Windows (#17932) against the same SDK fixture as the bash
// client. The script runs under Windows PowerShell 5.1 on Windows, and under
// PowerShell 7 elsewhere when `pwsh` is installed (GitHub's Ubuntu runners have
// it), so its protocol handling is checked on every platform that can run it.
function findPowerShell(): string | null {
  const candidates =
    process.platform === "win32"
      ? [
          path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe"
          ),
        ]
      : [process.env.DAINTREE_TEST_PWSH, "pwsh"].filter((c): c is string => !!c);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "exit 7"], {
      stdio: "ignore",
      timeout: 60_000,
    });
    if (probe.status === 7) return candidate;
  }
  return null;
}

const POWERSHELL = findPowerShell();

/** argv as one Windows command line, quoted so the MSVC runtime splits it back unchanged. */
function windowsCommandLine(args: string[]): string {
  return args
    .map((arg) => {
      if (arg !== "" && !/[ \t"]/.test(arg)) return arg;
      let out = '"';
      let backslashes = 0;
      for (const ch of arg) {
        if (ch === "\\") {
          backslashes++;
          continue;
        }
        out +=
          ch === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${ch}`;
        backslashes = 0;
      }
      return `${out}${"\\".repeat(backslashes * 2)}"`;
    })
    .join(" ");
}

/**
 * The client's own exit status, as the shim reads it back: 40-45 for 0-5 and
 * 170 for an interrupt. Anything else means PowerShell never ran the script to
 * one of its own exits, and is kept out of range so no expectation matches it.
 */
function clientStatus(raw: number | null): number | null {
  if (raw === null) return null;
  if (raw >= 40 && raw <= 45) return raw - 40;
  if (raw === 170) return 130;
  return 1000 + raw;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The environment a run starts from: none of the caller's Daintree variables. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^DAINTREE_/i.test(key)) env[key] = value;
  }
  env.POWERSHELL_TELEMETRY_OPTOUT = "1";
  env.POWERSHELL_UPDATECHECK = "Off";
  return env;
}

describe.skipIf(POWERSHELL === null)("daintree call on Windows: the PowerShell client", () => {
  let fixture: Fixture;
  let tmpDir: string;
  const children = new Set<ChildProcess>();

  function start(
    args: string[],
    env: Record<string, string | undefined> = {},
    stdin?: string | null,
    command = "call"
  ) {
    const merged: NodeJS.ProcessEnv = {
      ...baseEnv(),
      TMPDIR: tmpDir,
      TEMP: tmpDir,
      TMP: tmpDir,
      DAINTREE_CLI_ARGS: windowsCommandLine([command, ...args]),
      DAINTREE_MCP_URL: fixture.url,
      DAINTREE_MCP_TOKEN: TOKEN,
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    const child = spawn(
      POWERSHELL!,
      ["-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", CLIENT],
      { env: merged }
    );
    children.add(child);
    child.stdin.on("error", () => {});
    // null leaves stdin open, as a terminal would.
    if (stdin !== null) child.stdin.end(stdin ?? "");
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const done = new Promise<Run>((resolve) => {
      child.on("close", (raw) => {
        children.delete(child);
        resolve({
          status: clientStatus(raw),
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
    return { child, done };
  }

  const call = (args: string[], env?: Record<string, string | undefined>, stdin?: string) =>
    start(args, env, stdin).done;
  const session = (args: string[], env?: Record<string, string | undefined>) =>
    start(args, env, undefined, "session").done;

  async function held(): Promise<string> {
    const run = await session(["start"]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const handle = run.stdout.replace(/\n$/, "");
    expect(handle).not.toContain("\n");
    return handle;
  }

  const sessionOf = (handle: string) => {
    const opened = fixture.seen.find((r) => r.rpc?.method === "notifications/initialized");
    expect(opened?.sessionId).toBeTruthy();
    expect(handle).toBe(`${NEGOTIATED_VERSION}:${opened?.sessionId}`);
    return opened?.sessionId ?? "";
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-call-ps-"));
    fixture = await startFixture();
  });

  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    await fixture.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is ASCII, which Windows PowerShell reads correctly without a byte order mark", () => {
    expect(fs.readFileSync(CLIENT, "latin1")).toMatch(/^[\t\n\r\x20-\x7e]*$/);
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
    expect(fixture.sessions.size).toBe(0);
  });

  it("carries string values through byte for byte, both ways", async () => {
    const values = {
      quotes: `say "hi" and 'bye'`,
      slashes: "C:\\dir\\n is not a newline \\u0041",
      trailing: "ends in a backslash\\",
      quotedSlashes: 'a\\\\"b',
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

  it("splits its arguments the way the MSVC runtime splits a command line", async () => {
    const run = await call([], {
      DAINTREE_CLI_ARGS:
        'call fixture.echo --arg "spaced=a b" --arg q=x\\"y --arg "doubled=say ""hi""" --arg tail="C:\\dir\\\\"',
    });

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(fixture.seen[2].rpc?.params?.arguments).toEqual({
      spaced: "a b",
      q: 'x"y',
      doubled: 'say "hi"',
      tail: "C:\\dir\\",
    });
  });

  it("passes typed arguments from --args unchanged", async () => {
    const typed = { limit: 5, force: true, ids: [1, "a", null], nested: { depth: { ok: false } } };

    const run = await call(["fixture.echo", "--args", JSON.stringify(typed)]);

    expect(run.status).toBe(0);
    expect(fixture.seen[2].rpc?.params?.arguments).toEqual(typed);
  });

  it("reads --args - from stdin as UTF-8, a byte order mark and all", async () => {
    const typed = { prompt: "line one\nline two ☃", wait: true };

    const plain = await call(["fixture.echo", "--args", "-"], {}, `${JSON.stringify(typed)}\n`);
    expect(plain.stderr).toBe("");
    expect(plain.status).toBe(0);
    expect(fixture.seen[2].rpc?.params?.arguments).toEqual(typed);

    const marked = await call(
      ["fixture.echo", "--args", "-"],
      {},
      `\ufeff${JSON.stringify(typed)}`
    );
    expect(marked.status).toBe(0);
    expect(
      fixture.seen.filter((r) => r.rpc?.method === "tools/call")[1].rpc?.params?.arguments
    ).toEqual(typed);
  });

  it("prints the whole result, exactly as sent, with --json", async () => {
    const run = await call(["fixture.echo", "--arg", "a=1", "--json"]);

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      content: [{ type: "text", text: '{"a":"1"}' }],
      structuredContent: { echoed: { a: "1" } },
    });
    const sent = fixture.seen[2].response.match(/"result":(\{.*\}),"jsonrpc"/)?.[1];
    expect(sent).toBeDefined();
    expect(run.stdout).toBe(`${sent}\n`);
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
    expect(fixture.seen[2].response.indexOf("notifications/message")).toBeGreaterThan(-1);
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

  it("exits 1 when Daintree has no such tool", async () => {
    const run = await call(["fixture.nope"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("fixture.nope");
  });

  it("talks to 127.0.0.1/mcp when handed a localhost or /sse URL", async () => {
    const run = await call(["fixture.echo"], {
      DAINTREE_MCP_URL: fixture.url.replace("127.0.0.1", "localhost").replace(/\/mcp$/, "/sse"),
    });

    expect(run.status).toBe(0);
    expect(new Set(fixture.seen.map((request) => request.path))).toEqual(new Set(["/mcp"]));
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
    [["fixture.echo", "--args", '{"a":01}'], "one JSON object"],
    [["fixture.echo", "--args", '{"a":1,}'], "expected a key"],
    [["fixture.echo", "--args", `${"[".repeat(202)}${"]".repeat(202)}`], "nested too deep"],
    [["fixture.echo", "other"], "one tool name"],
    [["fixture.echo", "--bogus"], "unknown option"],
  ])("refuses %j before contacting Daintree", async (args, message) => {
    const run = await call(args);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(message);
    expect(fixture.seen).toEqual([]);
  });

  it("reports a usage error before a missing credential, without waiting on stdin", async () => {
    const run = await start(
      ["fixture.echo", "--args", "-", "--bogus"],
      { DAINTREE_MCP_TOKEN: undefined },
      null
    ).done;

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown option");
  });

  it("explains itself with --help", async () => {
    const run = await call(["--help"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Usage: daintree call <tool>");

    const sessionHelp = await session(["--help"]);
    expect(sessionHelp.status).toBe(0);
    expect(sessionHelp.stdout).toContain("Usage: daintree session start");
    expect(fixture.seen).toEqual([]);
  });

  it("gives a terminal without the pane's variables the bash client's message", async () => {
    const run = await call(["fixture.echo"], {
      DAINTREE_MCP_URL: undefined,
      DAINTREE_MCP_TOKEN: undefined,
    });

    expect(run.status).toBe(4);
    const bash = fs.readFileSync(path.join(HERE, "daintree-cli.sh"), "utf8");
    const message = bash.match(
      /daintree_call_fail 4 "(DAINTREE_MCP_TOKEN is not set\.[^"]*)"/
    )?.[1];
    expect(message).toBeDefined();
    expect(run.stderr).toBe(`daintree call: ${message}\n`);
  });

  it.each([
    [{ DAINTREE_MCP_URL: undefined }, "DAINTREE_MCP_URL is not set"],
    [{ DAINTREE_MCP_URL: "http://example.com:45454/mcp" }, "local endpoint"],
    [{ DAINTREE_MCP_URL: "https://127.0.0.1:45454/mcp" }, "local endpoint"],
    [{ DAINTREE_MCP_URL: "HTTP://127.0.0.1:45454/mcp" }, "local endpoint"],
    [{ DAINTREE_MCP_URL: "http://127.0.0.1:0/mcp" }, "local endpoint"],
    [{ DAINTREE_MCP_URL: "http://127.0.0.1:65536/mcp" }, "local endpoint"],
    [{ DAINTREE_MCP_TOKEN: "bad\nInjected: header" }, "malformed"],
    [{ DAINTREE_MCP_TOKEN: "two words" }, "malformed"],
    [{ DAINTREE_MCP_TOKEN: "pane-bearer-é" }, "malformed"],
    [{ DAINTREE_MCP_TOKEN: "pane-bearer-\u007f" }, "malformed"],
    [{ DAINTREE_MCP_URL: "http://127.0.0.1:45454/mcp\n" }, "local endpoint"],
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

  it("exits 4 for a 401 even when its body is cut short", async () => {
    await fixture.close();
    fixture = await startFixture({ truncatedRefusal: true });

    const run = await call(["fixture.echo"]);

    expect(run.status).toBe(4);
    expect(run.stderr).toContain("401");
  });

  it.each([
    ["never completed", { brokenInitialize: true }, "half-open"],
    ["dropped after its headers", { droppedInitialize: true }, "dropped"],
  ])("closes a session whose initialize reply %s", async (_name, options, sessionId) => {
    await fixture.close();
    fixture = await startFixture(options);

    const run = await call(["fixture.echo"]);

    expect(run.status).toBe(3);
    expect(fixture.seen.map((request) => [request.method, request.sessionId])).toEqual([
      ["POST", undefined],
      ["DELETE", sessionId],
    ]);
  });

  const handshakeRefusal = JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32010, message: "Start the Assistant again." },
    id: null,
  });

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
    [
      "no session",
      {
        status: 200,
        body: 'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25"}}\n\n',
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

  it("exits 1 when Daintree refuses the call before running it", async () => {
    await fixture.close();
    fixture = await startFixture({
      callReply: handshakeRefusal.replace("Start the Assistant again.", "Too large"),
    });

    const run = await call(["fixture.echo"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Too large");
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
      "a key that differs only in case",
      '{"jsonrpc":"2.0","id":2,"result":{"iserror":true,"content":[]}}',
      0,
    ],
    [
      "a key that only differs by an escaped control character",
      '{"jsonrpc":"2.0","id":2,"result":{"isError":true,"isError\\u0000":false,"content":[]}}',
      1,
    ],
    [
      "an id past the range of a double before the answer",
      'data: {"jsonrpc":"2.0","id":1e400,"result":{"content":[]}}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"yes"}]}}\n\n',
      0,
      "yes\n",
    ],
    [
      "surrogates that aren't an escaped pair",
      sse({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "x" }] } }).replace(
        '"text":"x"',
        '"text":"\\ud83d\\u0000\\ude00"'
      ),
      0,
      "\ufffd\ufffd\n",
    ],
    ["a null result", sse({ jsonrpc: "2.0", id: 2, result: null }), 3],
    ["no jsonrpc version", sse({ id: 2, result: text("x") }), 3],
    ["only another request's answer", sse({ jsonrpc: "2.0", id: 1, result: text("x") }), 3],
    ["an id written as 2.0", 'data: {"jsonrpc":"2.0","id":2.0,"result":{"content":[]}}\n\n', 0],
    [
      "a JSON-RPC error",
      sse({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad" } }),
      1,
      undefined,
      "bad (code -32602)\n",
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
    [
      "an answer split over data lines and CRLF",
      'event: message\r\ndata: {"jsonrpc":"2.0","id":2,\r\ndata: "result":{"content":[{"type":"text","text":"a\\u00e9\\ud83d\\ude00"}]}}\r\n\r\n',
      0,
      "aé😀\n",
    ],
  ])("reads a reply with %s", async (_name, reply, status, stdout?: string, stderr?: string) => {
    await fixture.close();
    fixture = await startFixture({
      callReply: reply.startsWith("{") ? `event: message\ndata: ${reply}\n\n` : reply,
    });

    const run = await call(["fixture.echo"]);

    expect(run.status).toBe(status);
    if (stdout !== undefined) expect(run.stdout).toBe(stdout);
    if (stderr !== undefined) expect(run.stderr).toBe(stderr);
  });

  it("gives up on a handshake whose reply is still trickling in after 10 seconds, and closes its session", async () => {
    const seen: { method: string | undefined; sessionId: string | string[] | undefined }[] = [];
    const trickling = http.createServer((req, res) => {
      seen.push({ method: req.method, sessionId: req.headers["mcp-session-id"] });
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "trickling" });
      res.write(": opening\n");
      const drip = setInterval(() => res.write(": still here\n"), 200);
      res.on("close", () => clearInterval(drip));
    });
    await new Promise<void>((resolve) => trickling.listen(0, "127.0.0.1", resolve));
    const { port } = trickling.address() as AddressInfo;
    try {
      const started = Date.now();
      const run = await call(["fixture.echo"], {
        DAINTREE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      });

      expect(run.status).toBe(3);
      expect(run.stderr).toContain("no answer within 10 seconds");
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(seen).toEqual([
        { method: "POST", sessionId: undefined },
        { method: "DELETE", sessionId: "trickling" },
      ]);
    } finally {
      trickling.closeAllConnections();
      await new Promise<void>((resolve) => trickling.close(() => resolve()));
    }
  }, 40_000);

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
    } finally {
      await new Promise<void>((resolve) => dropping.close(() => resolve()));
    }
  });

  it("writes nothing to disk, even while a call is out", async () => {
    const { child, done } = start(["fixture.slow"]);
    await fixture.callArrived;
    const written = fs.readdirSync(tmpDir, { recursive: true }) as string[];
    const holdsBearer = written.some((name) => {
      const file = path.join(tmpDir, name);
      return fs.statSync(file).isFile() && fs.readFileSync(file).includes(TOKEN);
    });
    expect(holdsBearer).toBe(false);
    child.kill("SIGKILL");
    await done;
  });

  // Ctrl+C reaches PowerShell as SIGINT off Windows; a console's Ctrl+C can't
  // be sent from a test on Windows.
  describe.skipIf(process.platform === "win32")("stopped with Ctrl+C", () => {
    async function interrupt(child: ChildProcess, done: Promise<Run>) {
      child.kill("SIGINT");
      return done;
    }

    it("keeps the bearer and the request body off every command line while a call is out", async () => {
      const marker = `prompt-${Date.now()}`;
      const { child, done } = start(
        ["fixture.slow", "--args", "-"],
        {},
        JSON.stringify({ marker })
      );
      await fixture.callArrived;
      const commandLines = execFileSync("ps", ["-A", "-ww", "-o", "args="], { encoding: "utf8" });
      expect(commandLines).toContain(CLIENT);
      expect(commandLines).not.toContain(TOKEN);
      expect(commandLines).not.toContain(marker);
      await interrupt(child, done);
    });

    it("closes the session when stopped mid-call", async () => {
      const { child, done } = start(["fixture.slow"]);
      await fixture.callArrived;

      const run = await interrupt(child, done);

      expect(run.status).toBe(130);
      expect(fixture.seen.at(-1)?.method).toBe("DELETE");
      expect(fixture.sessions.size).toBe(0);
    });

    it("closes a session whose initialize headers arrived but whose body is still out", async () => {
      await fixture.close();
      fixture = await startFixture({ stalledInitialize: true });
      const { child, done } = start(["fixture.echo"]);
      await fixture.stalled;
      // The stall is announced once the headers are flushed; give them a moment
      // to reach the client before the interrupt.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const run = await interrupt(child, done);

      expect(run.status).toBe(130);
      expect(fixture.seen.map((request) => [request.method, request.sessionId])).toEqual([
        ["POST", undefined],
        ["DELETE", "stalled"],
      ]);
    });

    it("closes the session when stopped while start is opening it", async () => {
      await fixture.close();
      fixture = await startFixture({ stall: "notifications/initialized" });

      const { child, done } = start(["start"], {}, undefined, "session");
      await fixture.stalled;
      const run = await interrupt(child, done);

      expect(run.status).toBe(130);
      expect(run.stdout).toBe("");
      expect(fixture.seen.at(-1)).toMatchObject({
        method: "DELETE",
        sessionId: fixture.seen[1].sessionId,
      });
      expect(fixture.sessions.size).toBe(0);
    });

    it("leaves a held session open when its call is stopped", async () => {
      const handle = await held();
      const { child, done } = start(["fixture.slow"], { DAINTREE_MCP_SESSION: handle });
      await fixture.callArrived;

      const run = await interrupt(child, done);

      expect(run.status).toBe(130);
      expect(fixture.seen.some((request) => request.method === "DELETE")).toBe(false);
      expect(fixture.sessions.size).toBe(1);
    });
  });

  describe("held session", () => {
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
        expect(request.rpc?.id as number).toBeGreaterThanOrEqual(2 ** 52);
      }
      expect(calls[0].rpc?.id).not.toBe(calls[1].rpc?.id);
      expect(fixture.sessions.size).toBe(1);
    });

    it("gives concurrent calls in one session different ids", async () => {
      const env = { DAINTREE_MCP_SESSION: await held() };

      const runs = await Promise.all(
        Array.from({ length: 3 }, (_, i) => call(["fixture.echo", "--arg", `n=${i}`], env))
      );

      expect(runs.map((run) => run.status)).toEqual([0, 0, 0]);
      expect(runs.map((run) => JSON.parse(run.stdout))).toEqual(
        Array.from({ length: 3 }, (_, i) => ({ n: String(i) }))
      );
      const ids = fixture.seen
        .filter((request) => request.rpc?.method === "tools/call")
        .map((request) => request.rpc?.id);
      expect(new Set(ids).size).toBe(3);
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
      expect(after.stderr).toContain("session start");
      const again = await session(["end"], { DAINTREE_MCP_SESSION: handle });
      expect(again.status).toBe(5);
      expect(fixture.seen.filter((request) => request.rpc?.method === "initialize")).toHaveLength(
        1
      );
    });

    it("fails a handle sent with another credential, leaving the session to its own", async () => {
      const handle = await held();
      const sessionId = sessionOf(handle);
      const foreign = { DAINTREE_MCP_SESSION: handle, DAINTREE_MCP_TOKEN: OTHER_TOKEN };

      expect((await call(["fixture.launch", "--arg", "terminalId=t-1"], foreign)).status).toBe(5);
      expect((await session(["end"], foreign)).status).toBe(5);

      expect(fixture.sessions.has(sessionId)).toBe(true);
      expect(fixture.seen.filter((r) => r.rpc?.method === "initialize")).toHaveLength(1);
    });

    it("exits 4 when Daintree refuses the bearer on a held call or on end", async () => {
      const handle = await held();
      const rotated = { DAINTREE_MCP_SESSION: handle, DAINTREE_MCP_TOKEN: "rotated" };

      expect((await call(["fixture.echo"], rotated)).status).toBe(4);
      expect((await session(["end"], rotated)).status).toBe(4);
      expect(fixture.seen.some((request) => request.method === "DELETE" && request.sessionId)).toBe(
        true
      );
      expect(fixture.sessions.size).toBe(1);
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
    });

    it.each([
      [[], "start or end"],
      [["bogus"], "start or end"],
      [["start", "extra"], "start or end"],
    ])("refuses session %j before contacting Daintree", async (args, message) => {
      const run = await session(args);

      expect(run.status).toBe(2);
      expect(run.stderr).toContain(message);
      expect(fixture.seen).toEqual([]);
    });

    it.each([
      [["end"], { DAINTREE_MCP_SESSION: undefined }],
      [["end"], { DAINTREE_MCP_SESSION: "no-version" }],
      [["start"], { DAINTREE_MCP_SESSION: `${NEGOTIATED_VERSION}:held` }],
    ])("refuses session %j with %j before contacting Daintree", async (args, env) => {
      const run = await session(args, env);

      expect(run.status).toBe(2);
      expect(run.stderr).toContain("DAINTREE_MCP_SESSION");
      expect(fixture.seen).toEqual([]);
    });

    it.each([
      "no-version",
      "2025-06-18:",
      ":abc",
      "2025-06-18:has space",
      "v 1:abc",
      "2025-06-18:abc\n",
      "2025-06-18\n:abc",
    ])("refuses a malformed handle %j before contacting Daintree", async (handle) => {
      const run = await call(["fixture.echo"], { DAINTREE_MCP_SESSION: handle });

      expect(run.status).toBe(2);
      expect(run.stderr).toContain("DAINTREE_MCP_SESSION");
      expect(fixture.seen).toEqual([]);
    });

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
  });
});

// The installed command end to end: bin\daintree.cmd rendered as afterPack
// writes it, beside the resources folder the client ships in.
describe.skipIf(process.platform !== "win32" || POWERSHELL === null)(
  "daintree call on Windows: through bin\\daintree.cmd",
  () => {
    let fixture: Fixture;
    let install: string;
    let shim: string;

    beforeEach(async () => {
      install = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-install-"));
      fs.mkdirSync(path.join(install, "bin"));
      fs.mkdirSync(path.join(install, "resources"));
      shim = path.join(install, "bin", "daintree.cmd");
      fs.writeFileSync(
        shim,
        renderWindowsCliShim(fs.readFileSync(WINDOWS_CLI_TEMPLATE, "utf8"), {
          version: "1.2.3",
          executable: "Daintree.exe",
        })
      );
      fs.copyFileSync(CLIENT, path.join(install, "resources", "daintree-call.ps1"));
      fixture = await startFixture();
    });

    afterEach(async () => {
      await fixture.close();
      fs.rmSync(install, { recursive: true, force: true });
    });

    function run(
      shell: "cmd" | "powershell",
      commandLine: string,
      env: Record<string, string | undefined> = {},
      stdin = ""
    ): Promise<Run> {
      const merged: NodeJS.ProcessEnv = {
        ...baseEnv(),
        DAINTREE_MCP_URL: fixture.url,
        DAINTREE_MCP_TOKEN: TOKEN,
      };
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete merged[key];
        else merged[key] = value;
      }
      const child =
        shell === "cmd"
          ? spawn("cmd.exe", ["/d", "/s", "/c", `""${shim}" ${commandLine}"`], {
              env: merged,
              windowsVerbatimArguments: true,
            })
          : spawn(
              POWERSHELL!,
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `& '${shim.replaceAll("'", "''")}' ${commandLine}; exit $LASTEXITCODE`,
              ],
              { env: merged }
            );
      child.stdin.end(stdin);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      return new Promise<Run>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status) =>
          resolve({
            status,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          })
        );
      });
    }

    it.each(["cmd", "powershell"] as const)(
      "makes a call from %s, with --args - on stdin",
      async (shell) => {
        const result = await run(
          shell,
          "call fixture.echo --args -",
          {},
          '{"limit":5,"q":"a & b"}'
        );

        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ limit: 5, q: "a & b" });
        expect(fixture.sessions.size).toBe(0);
      }
    );

    it("takes a quoted --arg and inline --args from cmd", async () => {
      const spaced = await run("cmd", 'call fixture.echo --arg "query=send to an owned terminal"');
      expect(spaced.status).toBe(0);
      expect(JSON.parse(spaced.stdout)).toEqual({ query: "send to an owned terminal" });

      const inline = await run("cmd", 'call fixture.echo --args "{\\"limit\\":5}"');
      expect(inline.status).toBe(0);
      expect(JSON.parse(inline.stdout)).toEqual({ limit: 5 });
    });

    it.each(["cmd", "powershell"] as const)(
      "carries each exit status through %s",
      async (shell) => {
        expect((await run(shell, "call fixture.refuse")).status).toBe(1);
        expect((await run(shell, "call")).status).toBe(2);
        expect(
          (await run(shell, "call fixture.echo", { DAINTREE_MCP_URL: "http://127.0.0.1:1/mcp" }))
            .status
        ).toBe(3);
        const missing = await run(shell, "call fixture.echo", { DAINTREE_MCP_TOKEN: undefined });
        expect(missing.status).toBe(4);
        expect(missing.stderr).toContain("DAINTREE_MCP_TOKEN is not set");
        expect(
          (await run(shell, "call fixture.echo", { DAINTREE_MCP_SESSION: "2025-06-18:gone" }))
            .status
        ).toBe(5);
      }
    );

    it("ignores a DAINTREE_CLI_ARGS the caller already had", async () => {
      const result = await run("cmd", "call fixture.echo --arg a=1", {
        DAINTREE_CLI_ARGS: "call fixture.refuse",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ a: "1" });
    });

    it("reads a client that never reached its own exit as no answer", async () => {
      // As Windows PowerShell exits when a policy refuses to run the script.
      fs.writeFileSync(path.join(install, "resources", "daintree-call.ps1"), "exit 1\r\n");

      const result = await run("cmd", "call fixture.echo");

      expect(result.status).toBe(3);
      expect(result.stderr).toContain("couldn't run");
      expect(result.stderr).toContain("(exit status 1)");
      expect(fixture.seen).toEqual([]);
    });

    it("takes inline JSON and holds a session from PowerShell", async () => {
      const inline = await run("powershell", `call fixture.echo --args '{\\"limit\\":5}'`);
      expect(inline.stderr).toBe("");
      expect(inline.status).toBe(0);
      expect(JSON.parse(inline.stdout)).toEqual({ limit: 5 });

      const quoted = shim.replaceAll("'", "''");
      const script = [
        `$handle = & '${quoted}' session start`,
        "if ($LASTEXITCODE -ne 0) { exit 10 + $LASTEXITCODE }",
        "$env:DAINTREE_MCP_SESSION = $handle",
        `& '${quoted}' call fixture.launch --arg terminalId=t-1`,
        "if ($LASTEXITCODE -ne 0) { exit 20 + $LASTEXITCODE }",
        `& '${quoted}' call fixture.send --arg terminalId=t-1`,
        "if ($LASTEXITCODE -ne 0) { exit 30 + $LASTEXITCODE }",
        `& '${quoted}' session end`,
        "exit $LASTEXITCODE",
      ].join("; ");
      const held = await new Promise<Run>((resolve, reject) => {
        const child = spawn(POWERSHELL!, ["-NoProfile", "-NonInteractive", "-Command", script], {
          env: { ...baseEnv(), DAINTREE_MCP_URL: fixture.url, DAINTREE_MCP_TOKEN: TOKEN },
        });
        child.stdin.end();
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });

      expect(held.stderr).toBe("");
      expect(held.status).toBe(0);
      expect(held.stdout).toContain("sent to t-1");
      expect(fixture.seen.filter((r) => r.rpc?.method === "initialize")).toHaveLength(1);
      expect(fixture.sessions.size).toBe(0);
    });
  }
);
