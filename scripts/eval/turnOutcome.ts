import { TURN_OUTCOME_CLASS_DESCRIPTIONS, TURN_OUTCOME_CLASS_ORDER } from "./turnOutcomeLib.js";
import { runTurnOutcomeEval, type JudgeResult } from "./turnOutcomeRun.js";
import type { AssistantTurnRecord, TurnOutcomeClass } from "../../shared/types/ipc/mcpServer.js";

// ---------------------------------------------------------------------------
// Judge batching
// ---------------------------------------------------------------------------

const BATCH_SIZE = 25;
const MAX_CONCURRENCY = 8;

async function runJudge(
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

  const results = await Promise.all(
    batches.map((batch) => limit(() => classifyBatch(batch, model, apiKey)))
  );

  const predictions: TurnOutcomeClass[] = [];
  let failures = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.error && result.predictions.length === 0) {
      // Complete batch failure — fill with unknown
      failures += batches[i].length;
      predictions.push(...Array(batches[i].length).fill("unknown" as TurnOutcomeClass));
    } else {
      predictions.push(...result.predictions);
      if (result.error) {
        // Partial failure — some predictions returned
        failures += batches[i].length - result.predictions.length;
      }
    }
  }

  return { predictions, failures };
}

const JUDGE_SCHEMA = {
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

interface BatchResult {
  predictions: TurnOutcomeClass[];
  error?: string;
}

async function classifyBatch(
  batch: AssistantTurnRecord[],
  model: string,
  apiKey: string
): Promise<BatchResult> {
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey });

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

  try {
    const response = await openai.responses.create({
      model,
      input: prompt,
      text: {
        format: {
          type: "json_schema" as const,
          name: "turnOutcomeJudgment",
          schema: JUDGE_SCHEMA,
          strict: true,
        },
      },
    });

    const content = response.output_text;
    if (!content) {
      return { predictions: [], error: "Empty response from judge" };
    }

    const parsed = JSON.parse(content);
    const classificationList = parsed.classifications;
    if (!Array.isArray(classificationList)) {
      return { predictions: [], error: "Response missing classifications array" };
    }

    // Build a map from id to outcome, then align to batch order
    const outcomeById = new Map<string, TurnOutcomeClass>();
    for (const item of classificationList) {
      if (TURN_OUTCOME_CLASS_ORDER.includes(item.outcome)) {
        outcomeById.set(item.id, item.outcome);
      }
    }

    const predictions = batch.map((r) => outcomeById.get(r.id) ?? "unknown");
    const missing = batch.length - [...outcomeById.values()].length;
    return {
      predictions,
      ...(missing > 0 ? { error: `${missing} records missing from judge response` } : {}),
    };
  } catch (err) {
    return { predictions: [], error: String(err) };
  }
}

runTurnOutcomeEval(process.argv.slice(2), { judge: runJudge }).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  }
);
