import type http from "node:http";
import { TOOLS } from "@daintreehq/decisions-client";

/**
 * The tools and words agents get on `/mcp/decisions`, held at what they were
 * before the 0.4.0 library added thread follow-ups (#16229). The library's
 * handler offers `send_followup`, a `thread` on `get_decision`, and tells
 * agents follow-ups exist, with no option to leave any of it out. Until
 * Daintree types a person's follow-ups (#16231) and serves the agent's
 * (#16232), none of that is true here, so each response is put back to the
 * 0.3.0 surface after the library has checked and answered the request.
 */

type McpHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
type JsonObject = Record<string, unknown>;

export const DECISIONS_MCP_INSTRUCTIONS =
  "Use ask_human for decisions that belong to the human. It does not wait: carry on with work that does not depend on the answer, and end your turn when you cannot go further without it. The answer arrives as a new message in this terminal.";

export function askedInstruction(alias: number): string {
  return `Asked as q-${alias}. Carry on with anything that does not depend on the answer; once you cannot go further without it, end your turn. The answer arrives as a new message in this terminal, with your question quoted.`;
}

const GET_DECISION_DESCRIPTION =
  "Check a question you asked with ask_human from this terminal, by question_id. Returns status, provenance, choice, text and reviewed_digests_match (true only if the human reviewed exactly the attached images). Only status human-answered with provenance human is a human decision; expired never authorises anything.";

/** Why `QuestionBridge` refuses a follow-up; its tool error is answered as an unknown tool. */
export const FOLLOW_UPS_NOT_SERVED = "follow-ups aren't served by Daintree yet";

const ASKED = /^Asked as q-(\d{1,9})\. /;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutThread(tool: JsonObject): JsonObject {
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

/** The library's tools without `send_followup`, and `get_decision` without its thread. */
export const DECISIONS_MCP_TOOLS: readonly JsonObject[] = (TOOLS as readonly JsonObject[])
  .filter((tool) => tool.name !== "send_followup")
  .map((tool) => (tool.name === "get_decision" ? withoutThread(tool) : tool));

function firstText(result: JsonObject): string | null {
  const content = Array.isArray(result.content) ? (result.content[0] as unknown) : undefined;
  return isObject(content) && typeof content.text === "string" ? content.text : null;
}

/** One JSON-RPC response, as the 0.3.0 handler would have given it. */
function heldResponse(message: unknown): unknown {
  if (!isObject(message) || !isObject(message.result)) return message;
  const result = message.result;
  if (typeof result.instructions === "string") {
    return { ...message, result: { ...result, instructions: DECISIONS_MCP_INSTRUCTIONS } };
  }
  if (Array.isArray(result.tools)) {
    return { ...message, result: { ...result, tools: DECISIONS_MCP_TOOLS } };
  }
  const structured = result.structuredContent;
  if (!isObject(structured)) return message;
  if (
    result.isError === true &&
    structured.error === "not_supported" &&
    firstText(result) === `not_supported: ${FOLLOW_UPS_NOT_SERVED}`
  ) {
    return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32602, message: "Unknown tool" } };
  }
  if ("thread" in structured) {
    const { thread: _thread, ...rest } = structured;
    return { ...message, result: { ...result, structuredContent: rest } };
  }
  const asked =
    typeof structured.instruction === "string" ? ASKED.exec(structured.instruction) : null;
  if (asked !== null) {
    const instruction = askedInstruction(Number(asked[1]));
    return {
      ...message,
      result: {
        ...result,
        content: [{ type: "text", text: instruction }],
        structuredContent: { ...structured, instruction },
      },
    };
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
 * `handler` with every JSON-RPC answer held at the 0.3.0 surface. The library
 * writes each response whole with one `end`, after its own Host, Origin,
 * bearer, rate and size checks, and sets no length, so the body can change.
 */
export function withoutFollowUps(handler: McpHandler): McpHandler {
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
