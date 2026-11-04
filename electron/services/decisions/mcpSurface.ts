import type http from "node:http";
import { TOOLS } from "@daintreehq/decisions-client";

/**
 * The tools agents get on `/mcp/decisions`: the library's own, words and
 * `send_followup` included (#16232), except that `get_decision` returns no
 * `thread`. Until Daintree takes the relay's thread events (#16231) none are
 * stored here, so a thread would list the answers without the agent's own
 * follow-ups. Each response is put back to that after the library has
 * checked and answered the request.
 */

type McpHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
type JsonObject = Record<string, unknown>;

const GET_DECISION_DESCRIPTION =
  "Check a question you asked with ask_human from this terminal, by question_id. Returns status, provenance, choice, text and reviewed_digests_match (true only if the human reviewed exactly the attached images). Only status human-answered with provenance human is a human decision; expired never authorises anything.";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutThreadOutput(tool: JsonObject): JsonObject {
  const outputSchema = isObject(tool.outputSchema) ? tool.outputSchema : {};
  const { thread: _thread, ...properties } = isObject(outputSchema.properties)
    ? outputSchema.properties
    : {};
  return {
    ...tool,
    description: GET_DECISION_DESCRIPTION,
    outputSchema: { ...outputSchema, properties },
  };
}

/** The library's tools, with `get_decision` returning no thread. */
export const DECISIONS_MCP_TOOLS: readonly JsonObject[] = (TOOLS as readonly JsonObject[]).map(
  (tool) => (tool.name === "get_decision" ? withoutThreadOutput(tool) : tool)
);

/** One JSON-RPC response, with the tools above and no thread. */
function heldResponse(message: unknown): unknown {
  if (!isObject(message) || !isObject(message.result)) return message;
  const result = message.result;
  if (Array.isArray(result.tools)) {
    return { ...message, result: { ...result, tools: DECISIONS_MCP_TOOLS } };
  }
  const structured = result.structuredContent;
  if (isObject(structured) && "thread" in structured) {
    const { thread: _thread, ...rest } = structured;
    return { ...message, result: { ...result, structuredContent: rest } };
  }
  return message;
}

function heldPayload(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  return JSON.stringify(Array.isArray(parsed) ? parsed.map(heldResponse) : heldResponse(parsed));
}

/**
 * `handler` with every JSON-RPC answer held to the tools above. The library
 * writes each response whole with one `end`, after its own Host, Origin,
 * bearer, rate and size checks, and sets no length, so the body can change.
 */
export function withoutThreads(handler: McpHandler): McpHandler {
  return (req, res) => {
    const end = res.end;
    res.end = function (this: http.ServerResponse, ...args: unknown[]) {
      if (typeof args[0] === "string" && this.statusCode === 200) {
        args[0] = heldPayload(args[0]);
      }
      return Reflect.apply(end, this, args) as http.ServerResponse;
    } as typeof res.end;
    return handler(req, res);
  };
}
