import { TURN_OUTCOME_CLASS_DESCRIPTIONS, TURN_OUTCOME_CLASS_ORDER } from "./turnOutcomeLib.js";
import type { JudgeResult } from "./turnOutcomeRun.js";
import type { AssistantTurnRecord, TurnOutcomeClass } from "../../shared/types/ipc/mcpServer.js";

const BATCH_SIZE = 25;
const MAX_CONCURRENCY = 8;

export const JUDGE_SCHEMA = {
  type: "object" as const,
  properties: {
    classifications: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          id: { type: "string" as const },
          outcome: {
            type: "string" as const,
            enum: [...TURN_OUTCOME_CLASS_ORDER],
          },
          reasoning: { type: "string" as const },
        },
        required: ["id", "outcome", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["classifications"],
  additionalProperties: false,
};

export function buildJudgePrompt(batch: AssistantTurnRecord[]): string {
  const recordsCtx = batch
    .map((r) => {
      const fields: string[] = [`id: ${r.id}`, `terminalId: ${r.terminalId ?? "null"}`];
      if (r.trigger) fields.push(`trigger: ${r.trigger}`);
      if (r.state) fields.push(`state: ${r.state}`);
      if (r.previousState) fields.push(`previousState: ${r.previousState}`);
      if (r.detail) fields.push(`detail: ${r.detail}`);
      return fields.join(", ");
    })
    .join("\n");

  const categories = TURN_OUTCOME_CLASS_ORDER.map(
    (cls) => `- ${cls}: ${TURN_OUTCOME_CLASS_DESCRIPTIONS[cls]}`
  ).join("\n");

  const prompt = `You are evaluating the outcome of AI assistant turns. Classify each turn below into exactly one of these categories:

${categories}

Classification rules:
- agent-stuck is ONLY when trigger is "timeout" AND state is "idle" AND previousState is "waiting"
- tier-rejected and tool-error typically have trigger "output" with detail indicating the error
- mcp-not-ready typically has no trigger or state fields and detail explains the failure
- hibernate-resume-stale typically has trigger "output"
- If no clear failure signal is present, classify as "answered"

Return a JSON object with a "classifications" array. Each element must have the record "id", your "outcome" classification, and a brief "reasoning".

Records:
${recordsCtx}`;
  return prompt;
}

/**
 * Align the judge's answer to batch order. `null` marks a record the judge
 * did not classify, so a failure never stands in for a prediction.
 */
export function parseJudgeResponse(
  batch: AssistantTurnRecord[],
  content: string | undefined
): Array<TurnOutcomeClass | null> {
  const outcomeById = new Map<string, TurnOutcomeClass>();
  try {
    const list = content
      ? (JSON.parse(content) as { classifications?: unknown }).classifications
      : null;
    for (const item of Array.isArray(list) ? list : []) {
      const { id, outcome } = (item ?? {}) as { id?: unknown; outcome?: unknown };
      if (
        typeof id === "string" &&
        TURN_OUTCOME_CLASS_ORDER.includes(outcome as TurnOutcomeClass)
      ) {
        outcomeById.set(id, outcome as TurnOutcomeClass);
      }
    }
  } catch {
    // Unparseable output classifies nothing.
  }
  return batch.map((r) => outcomeById.get(r.id) ?? null);
}

async function classifyBatch(
  batch: AssistantTurnRecord[],
  model: string,
  apiKey: string
): Promise<Array<TurnOutcomeClass | null>> {
  try {
    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey });
    const response = await openai.responses.create({
      model,
      input: buildJudgePrompt(batch),
      text: {
        format: {
          type: "json_schema" as const,
          name: "turnOutcomeJudgment",
          schema: JUDGE_SCHEMA,
          strict: true,
        },
      },
    });
    return parseJudgeResponse(batch, response.output_text);
  } catch {
    return batch.map(() => null);
  }
}

export async function runJudge(
  records: AssistantTurnRecord[],
  model: string,
  apiKey: string
): Promise<JudgeResult> {
  const pLimit = (await import("p-limit")).default;
  const limit = pLimit(MAX_CONCURRENCY);

  const batches: AssistantTurnRecord[][] = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    batches.push(records.slice(i, i + BATCH_SIZE));
  }

  const predictions = (
    await Promise.all(batches.map((batch) => limit(() => classifyBatch(batch, model, apiKey))))
  ).flat();
  return { predictions, failures: predictions.filter((p) => p === null).length };
}
