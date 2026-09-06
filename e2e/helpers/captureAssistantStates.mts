#!/usr/bin/env node
/**
 * Captures real assistant panel states by driving the fake engine through the whole
 * production pipeline, and writes them as JSON for the visual harness.
 *
 * ## Why capture rather than hand-write fixtures
 *
 * A hand-written fixture is a designer's belief about what the panel receives. It can
 * drift from what the engine actually sends and nobody notices, so the screenshots
 * end up reviewing a state the product cannot produce — the most expensive kind of
 * design review, because it looks like verification.
 *
 * These states come out of the real transport, the real Zod validation and the real
 * reducer, from an engine whose frames are separately proven schema-conformant. If a
 * state can be screenshotted here, it is reachable.
 *
 * Usage: npx tsx e2e/helpers/captureAssistantStates.mts [outFile]
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AssistantHostProcess } from "../../electron/services/assistant-host/AssistantHostProcess.js";
import { ASSISTANT_HOST_PROTOCOL_VERSION } from "../../shared/types/ipc/assistantHost.js";
import type { AssistantHostSessionDescriptor } from "../../shared/types/ipc/assistantHost.js";
import { useAssistantStore } from "../../src/store/assistantStore.js";
import type { AssistantSessionState } from "../../src/store/assistantStore.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, "fake-assistant-engine.mjs");
const OUT =
  process.argv[2] ??
  path.join(HERE, "../../src/components/AssistantPanel/__preview__/capturedStates.ts");

interface Capture {
  name: string;
  scenario: string;
  prompt: string;
  approve?: "approved" | "rejected";
  /** Stop as soon as this event lands, so a blocked state can be captured mid-turn. */
  until?: string;
}

/**
 * The states worth looking at. Two are captured MID-TURN (`until`), because the panel
 * states that most need design review — streaming, and parked on an approval — do not
 * exist once the turn has finished.
 */
const CAPTURES: Capture[] = [
  { name: "empty", scenario: "simple", prompt: "", until: "host:ready" },
  {
    name: "streaming",
    scenario: "long",
    prompt: "Walk me through the release steps",
    until: "turn:token",
  },
  { name: "toolBatch", scenario: "streaming", prompt: "Which worktrees are ready to review?" },
  {
    name: "approvalTyped",
    scenario: "approval",
    prompt: "Push the forge branch",
    until: "approval:requested",
  },
  {
    name: "approvalSimple",
    scenario: "approvalSimple",
    prompt: "Run the tests in wt_forge",
    until: "approval:requested",
  },
  {
    name: "question",
    scenario: "question",
    prompt: "Run the migration",
    until: "question:requested",
  },
  {
    // The long form is a DIFFERENT surface — past the filter threshold the sheet grows
    // a search box and hands it the keys the short form answers on — so it needs its
    // own picture or half the component is never looked at.
    name: "questionLong",
    scenario: "questionLong",
    prompt: "Run the migration",
    until: "question:requested",
  },
  { name: "asyncWork", scenario: "asyncWork", prompt: "Start a reviewer on wt_forge" },
  { name: "degraded", scenario: "degraded", prompt: "Summarise what the fleet did overnight" },
  { name: "droppedFrame", scenario: "droppedFrame", prompt: "Summarise the overnight runs" },
  { name: "turnError", scenario: "error", prompt: "What happened to run 3?" },
];

const descriptor: AssistantHostSessionDescriptor = {
  sessionId: "ses_capture",
  windowId: 1,
  projectId: "p_capture",
  cwd: process.cwd(),
  tier: "system",
  protocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION,
};

async function capture(spec: Capture): Promise<AssistantSessionState> {
  const store = useAssistantStore.getState();
  store.reset(descriptor.sessionId);

  let settle: () => void;
  const done = new Promise<void>((r) => {
    settle = r;
  });

  const host = new AssistantHostProcess({
    binaryPath: ENGINE,
    descriptor,
    cwd: process.cwd(),
    env: {
      ...process.env,
      FAKE_ENGINE_SCENARIO: spec.scenario,
      // A mid-stream capture must actually catch the turn IN FLIGHT. At full speed
      // the `long` scenario finishes inside the settle window, and the "streaming"
      // state ends up being a photograph of a completed turn — the one state it was
      // specifically meant not to be.
      FAKE_ENGINE_SPEED: spec.until === "turn:token" ? "6" : "0",
    } as Record<string, string>,
    onEvent: (event) => {
      useAssistantStore.getState().applyEvent(event);
      if (spec.until && event.type === spec.until) {
        // Let a couple more frames land so the state is representative rather than
        // caught on the very first token.
        setTimeout(() => settle(), spec.until === "turn:token" ? 900 : 30);
      }
      if (!spec.until && event.type === "turn:end") setTimeout(() => settle(), 30);
      if (event.type === "approval:requested" && spec.approve) {
        host.send({
          type: "approval:decide",
          sessionId: descriptor.sessionId,
          approvalId: event.approvalId,
          decision: spec.approve,
        });
      }
    },
    onSequenceGap: ({ missing }) => useAssistantStore.getState().recordGap(missing),
  });

  host.start();
  await host.waitForReady();

  if (spec.prompt) {
    useAssistantStore.getState().appendUserTurn(spec.prompt);
    host.send({ type: "prompt", sessionId: descriptor.sessionId, text: spec.prompt });
  } else {
    settle!();
  }

  await Promise.race([done, new Promise((r) => setTimeout(r, 12_000))]);
  host.dispose();

  // Serialize the DATA half of the store only. Picked explicitly rather than by
  // rest-destructuring the actions away: an added action would silently end up in the
  // JSON and break the harness's typing.
  //
  // The return is annotated `AssistantSessionState` so a field added to the store but
  // NOT added here fails compilation in this file. Without the annotation the omission
  // surfaced only in the generated `capturedStates.ts`, which points at the artifact
  // rather than at the line that needs editing.
  //
  // That annotation is necessary and NOT sufficient: this file is run with `tsx`,
  // which strips types without checking them, and the timer fields had already drifted
  // out of this list before anyone noticed. The omission still surfaces — as a build
  // failure in the generated artifact, one regeneration later — so the rule when
  // adding a field to the store is to add it HERE and regenerate, and the rule after
  // regenerating is to run the build rather than trusting the script's own silence.
  const s = useAssistantStore.getState();
  return {
    sessionId: s.sessionId,
    connection: s.connection,
    engineVersion: s.engineVersion,
    autoApprove: s.autoApprove,
    tier: s.tier,
    tierGloss: s.tierGloss,
    backend: s.backend,
    routing: s.routing,
    logFile: s.logFile,
    mcpUnavailable: s.mcpUnavailable,
    mcpToolCount: s.mcpToolCount,
    commands: s.commands,
    operations: s.operations,
    timers: s.timers,
    timersStale: s.timersStale,
    pendingFiredTimerIds: s.pendingFiredTimerIds,
    timerCancelPending: s.timerCancelPending,
    timerCancelErrors: s.timerCancelErrors,
    toolGrants: s.toolGrants,
    queuedInterjections: s.queuedInterjections,
    retractedDraft: s.retractedDraft,
    lastActivityAt: s.lastActivityAt,
    turnStartedAt: s.turnStartedAt,
    phaseIsWake: s.phaseIsWake,
    pendingQuestion: s.pendingQuestion,
    awaitingLocalCommand: s.awaitingLocalCommand,
    stoppedReason: s.stoppedReason,
    error: s.error,
    turns: s.turns,
    toolCalls: s.toolCalls,
    approvals: s.approvals,
    notices: s.notices,
    phase: s.phase,
    usage: s.usage,
    cost: s.cost,
    rateLimited: s.rateLimited,
    droppedFrames: s.droppedFrames,
  };
}

async function main() {
  const out: Record<string, unknown> = {};
  for (const spec of CAPTURES) {
    out[spec.name] = await capture(spec);
    process.stdout.write(`captured ${spec.name}\n`);
  }
  mkdirSync(path.dirname(OUT), { recursive: true });
  // Emitted as a TYPED MODULE rather than JSON. A JSON import widens every string
  // literal (`connection: string`), which then needs a type assertion at the import
  // site — and an assertion is exactly the wrong tool for data generated from the
  // real store, because it would hide a genuine shape change instead of failing on it.
  const body =
    `// AUTO-GENERATED by e2e/helpers/captureAssistantStates.mts — do not edit by hand.\n` +
    `//\n` +
    `// Real panel states, captured by driving the fake engine through the production\n` +
    `// pipeline: the transport, the Zod validation and the reducer. Regenerate with:\n` +
    `//   npx tsx e2e/helpers/captureAssistantStates.mts\n` +
    `import type { AssistantSessionState } from "@/store/assistantStore";\n\n` +
    `export const CAPTURED_STATES = ${JSON.stringify(out, null, 2)} satisfies Record<\n` +
    `  string,\n` +
    `  AssistantSessionState\n` +
    `>;\n\n` +
    `export type CapturedStateName = keyof typeof CAPTURED_STATES;\n`;
  writeFileSync(OUT, body);
  process.stdout.write(`wrote ${OUT}\n`);
  process.exit(0);
}

void main();
