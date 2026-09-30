/**
 * The smallest Streamable HTTP MCP client that does what an agent CLI does
 * with a server Daintree handed it: initialize, list tools, call one. Used to
 * prove the wiring a launch produced actually works, with the same URL and
 * bearer the agent received.
 */
export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface McpToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

function parseBody(contentType: string | null, body: string): unknown {
  if (contentType?.includes("text/event-stream")) {
    const data = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    return data.length > 0 ? JSON.parse(data[data.length - 1]) : null;
  }
  return body.trim() ? JSON.parse(body) : null;
}

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(
    readonly url: string,
    private readonly bearer: string
  ) {}

  private async post(message: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.bearer}`,
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    });
    const body = await response.text();
    if (!response.ok && response.status !== 202) {
      throw new McpHttpError(response.status, `${response.status} ${body.slice(0, 300)}`);
    }
    const sid = response.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    return parseBody(response.headers.get("content-type"), body);
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const reply = (await this.post({ id: this.nextId++, method, params })) as {
      result?: T;
      error?: { code: number; message: string };
    } | null;
    if (!reply) throw new Error(`${method}: empty reply`);
    if (reply.error) throw new Error(`${method}: ${reply.error.code} ${reply.error.message}`);
    return reply.result as T;
  }

  async initialize(): Promise<{ serverInfo?: { name?: string } }> {
    const result = await this.request<{ serverInfo?: { name?: string } }>("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "daintree-e2e", version: "0.0.0" },
    });
    await this.post({ method: "notifications/initialized" });
    return result;
  }

  async listTools(): Promise<string[]> {
    const result = await this.request<{ tools: Array<{ name: string }> }>("tools/list", {});
    return result.tools.map((tool) => tool.name).sort();
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    return this.request<McpToolResult>("tools/call", { name, arguments: args });
  }

  /** A tool result's JSON payload, from structured content or its first text block. */
  async callJson<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.callTool(name, args);
    const text = result.content?.find((block) => block.type === "text")?.text ?? "";
    if (result.isError) throw new Error(`${name} failed: ${text}`);
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    return JSON.parse(text) as T;
  }
}

/**
 * The HTTP status an MCP endpoint answers a bearer with, the way the agent
 * would first reach it: a legacy `/sse` URL opens its event stream (dropped as
 * soon as the status is in), anything else is a Streamable HTTP `initialize`.
 */
export async function mcpEndpointStatus(url: string, bearer: string): Promise<number> {
  if (new URL(url).pathname === "/sse") {
    const abort = new AbortController();
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${bearer}` },
        signal: abort.signal,
      });
      return response.status;
    } finally {
      abort.abort();
    }
  }
  return new McpHttpClient(url, bearer).initialize().then(
    () => 200,
    (err: unknown) => {
      if (err instanceof McpHttpError) return err.status;
      throw err;
    }
  );
}
