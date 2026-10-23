// A small stdio MCP server for adapter tests: newline-delimited JSON-RPC, no
// SDK, no network. Its label (FIXTURE_LABEL) and pid let a test tell two
// instances apart; FIXTURE_EXTRA_TOOL adds a tool after a list_changed.
import process from "node:process";

const label = process.env.FIXTURE_LABEL ?? "";
const pending = new Map();
let extraTool = false;

const object = (properties = {}, required = []) => ({ type: "object", properties, required });

function tools() {
  const list = [
    {
      name: "echo-text",
      description: "Echo the given text back.",
      inputSchema: object({ text: { type: "string" } }, ["text"]),
      annotations: { readOnlyHint: true },
    },
    { name: "whoami", description: "", inputSchema: object() },
    { name: "fail", description: "Always fails as a tool.", inputSchema: object() },
    { name: "image", description: "Returns an image.", inputSchema: object() },
    { name: "big", description: "Returns a large result.", inputSchema: object() },
    { name: "slow", description: "Answers only when cancelled.", inputSchema: object() },
    { name: "crash", description: "Exits the process.", inputSchema: object() },
    { name: "ask-ping", description: "Pings the client first.", inputSchema: object() },
    { name: "change-tools", description: "Announces a tool list change.", inputSchema: object() },
    { name: "secret", description: "Never allowlisted.", inputSchema: object() },
  ];
  if (extraTool) list.push({ name: "extra", description: "Added later.", inputSchema: object() });
  return list;
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

const text = (value) => ({ content: [{ type: "text", text: value }] });

function callTool(id, name, args) {
  switch (name) {
    case "echo-text":
      return send({ id, result: text(String(args.text)) });
    case "whoami":
      return send({ id, result: text(`${label}:${process.pid}`) });
    case "fail":
      return send({ id, result: { ...text("it broke"), isError: true } });
    case "image":
      return send({
        id,
        result: { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
      });
    case "big":
      return send({ id, result: text("x".repeat(300 * 1024)) });
    case "slow":
      pending.set(id, "slow");
      return;
    case "crash":
      process.exit(3);
      return;
    case "ask-ping": {
      // Deliberately reuses the client's id, which a client must not read as its own answer.
      pending.set(`ping:${id}`, id);
      return send({ id, method: "ping" });
    }
    case "change-tools":
      extraTool = true;
      send({ id, result: text("changed") });
      return send({ method: "notifications/tools/list_changed" });
    default:
      return send({ id, error: { code: -32602, message: `Unknown tool: ${name}` } });
  }
}

function handle(message) {
  const { id, method, params } = message;
  if (method === undefined) {
    // An answer to a request this server sent.
    const callId = pending.get(`ping:${id}`);
    if (callId !== undefined && message.result !== undefined) {
      pending.delete(`ping:${id}`);
      send({ id: callId, result: text("pong received") });
    }
    return;
  }
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "synthetic", version: "1" },
        },
      });
    case "notifications/initialized":
      return;
    case "notifications/cancelled":
      if (pending.delete(params?.requestId)) {
        process.stderr.write(`cancelled ${params.requestId}\n`);
        // A late answer the client must drop.
        send({ id: params.requestId, result: text("too late") });
      }
      return;
    case "tools/list":
      return send({ id, result: { tools: tools() } });
    case "tools/call":
      return callTool(id, params?.name, params?.arguments ?? {});
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: "Method not found" } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
