import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  AssistantHostEventSchema,
  ASSISTANT_HOST_PROTOCOL_VERSION,
} from "../../../electron/schemas/ipc.js";

/**
 * Fidelity guard for the fake assistant engine.
 *
 * The fake exists so E2E tests can drive exact assistant behaviour without a backend.
 * That is only worth anything while it stays a faithful stand-in for the real Go
 * engine — a fake that drifts does not fail, it quietly starts testing a fiction, and
 * every test built on it keeps passing while the product breaks.
 *
 * So every scenario is driven here and its output validated against the SAME Zod
 * schema the main process uses in production. A shape the real engine could not
 * produce fails here, in a fast unit run, rather than becoming a green E2E suite
 * asserting things about a protocol nobody speaks.
 */

const ENGINE = path.resolve(__dirname, "../fake-assistant-engine.mjs");

/**
 * Every scenario the fake can run.
 *
 * Kept complete deliberately, and checked against the fake's own table below: a
 * scenario that is not driven here is a scenario whose frames nobody validates, which
 * is precisely where drift hides. `question` and `cancellable` were missing for exactly
 * that reason and are the two that park waiting for input, so they are the likeliest to
 * emit something odd.
 */
const SCENARIOS = [
  "simple",
  "streaming",
  "approval",
  "approvalSimple",
  "authoritativeContent",
  "droppedFrame",
  "degraded",
  "asyncWork",
  "reasoning",
  "error",
  "long",
  "paragraphs",
  "question",
  "questionLong",
  "cancellable",
  "wake",
  "proseThenTool",
] as const;

/**
 * Scenarios that deliberately END BADLY, and so cannot be driven by the clean-exit case
 * above. Listed rather than omitted: the completeness guard counts both lists, so a
 * scenario cannot escape validation simply by being awkward.
 */
const DYING_SCENARIOS = ["crash"] as const;

interface Run {
  frames: Array<Record<string, unknown>>;
  stderr: string;
  exitCode: number | null;
}

/** Boots the fake, runs one prompt, answers any approval, then shuts down. */
function drive(scenario: string, decision: "approved" | "rejected" = "approved"): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENGINE, "host", "--stdio"], {
      env: {
        ...process.env,
        FAKE_ENGINE_SCENARIO: scenario,
        // No artificial delay: these assert protocol shape, not timing.
        FAKE_ENGINE_SPEED: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const frames: Array<Record<string, unknown>> = [];
    let buffer = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) frames.push(JSON.parse(line));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });

    child.on("exit", (code) => resolve({ frames, stderr, exitCode: code }));

    const sessionId = "ses_fake_test";
    child.stdin.write(
      `${JSON.stringify({
        sessionId,
        windowId: 1,
        projectId: "p_fake",
        cwd: "/tmp",
        tier: "system",
        protocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION,
      })}\n`
    );

    setTimeout(
      () => child.stdin.write(`${JSON.stringify({ type: "prompt", sessionId, text: "go" })}\n`),
      20
    );
    // Answer both approval ids the scenarios use; an id nothing is parked on is a no-op.
    setTimeout(() => {
      for (const approvalId of ["apr_1", "apr_2"]) {
        child.stdin.write(
          `${JSON.stringify({ type: "approval:decide", sessionId, approvalId, decision })}\n`
        );
      }
    }, 220);
    setTimeout(
      () => child.stdin.write(`${JSON.stringify({ type: "shutdown", sessionId })}\n`),
      600
    );
    setTimeout(() => child.kill("SIGKILL"), 8_000);
  });
}

const ENGINE_SOURCE = readFileSync(ENGINE, "utf8");
const RUNPHASE_GO = path.resolve(
  __dirname,
  "../../../vendor/daintree-assistant/internal/domain/runphase.go"
);

describe("fake assistant engine", () => {
  it("drives every scenario it defines", () => {
    // A scenario the fake can run but this file never drives is a scenario whose frames
    // are validated by nothing. The list above is hand-written, so it has to be checked
    // against the fake rather than trusted.
    const defined = [
      ...ENGINE_SOURCE.slice(
        ENGINE_SOURCE.indexOf("const SCENARIOS = {"),
        ENGINE_SOURCE.indexOf("\n};", ENGINE_SOURCE.indexOf("const SCENARIOS = {"))
      ).matchAll(/^ {2}(?:async )?([a-zA-Z][a-zA-Z0-9]*)\(/gm),
    ].map((m) => m[1]!);
    expect(defined.length, "the scenario table could not be read").toBeGreaterThan(5);
    const driven = new Set<string>([...SCENARIOS, ...DYING_SCENARIOS]);
    const undriven = defined.filter((name) => !driven.has(name));
    expect(undriven, `scenarios nothing validates: ${undriven.join(", ")}`).toEqual([]);
  });

  it("uses only phase names the real engine can emit", () => {
    // The exact drift this file exists to catch, and it had happened: the fake emitted
    // `tool-running`, `awaiting-approval` and `awaiting-question`, which the Go engine
    // spells `tool_running`, `awaiting_approval` and `awaiting_question`. The Zod schema
    // accepts any string for `phase` — it has to, since a future engine may add one — so
    // nothing rejected them, and the panel's phase labels were being exercised against
    // three names the product never sends.
    //
    // Read from the Go source rather than restated, so an engine-side rename fails here.
    const go = readFileSync(RUNPHASE_GO, "utf8");
    const block = /phaseNames\s*=\s*map\[RunPhase\]string\{([\s\S]*?)\n\s*\}/.exec(go);
    expect(block, "phaseNames not found in runphase.go").not.toBeNull();
    const real = new Set([...block![1]!.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!));
    expect(real.size).toBeGreaterThanOrEqual(10);

    const used = [...ENGINE_SOURCE.matchAll(/phase:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(used.length, "no phases found in the fake").toBeGreaterThan(5);
    const impossible = [...new Set(used)].filter((p) => !real.has(p));
    expect(
      impossible,
      `the fake emits phases the real engine never sends: ${impossible.join(", ")}`
    ).toEqual([]);
  });

  it.each(SCENARIOS)(
    "scenario %s emits only frames Daintree can parse",
    async (scenario) => {
      const { frames, exitCode } = await drive(scenario);

      expect(frames.length, `scenario ${scenario} emitted nothing`).toBeGreaterThan(0);

      for (const frame of frames) {
        const parsed = AssistantHostEventSchema.safeParse(frame);
        expect(
          parsed.success,
          `the fake engine emitted a frame the real schema rejects — it has drifted from ` +
            `the engine it stands in for.\nframe: ${JSON.stringify(frame)}\n` +
            `error: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`
        ).toBe(true);
      }

      expect(exitCode).toBe(0);
    },
    15_000
  );

  it.each(DYING_SCENARIOS)(
    "scenario %s emits parseable frames right up to the moment it dies",
    async (scenario) => {
      // A crash is the failure the panel has to SETTLE from, and the frames it emits on
      // the way down are the last thing the panel sees. If they were malformed, the
      // panel would be reconciling a corrupt state on top of an unexpected exit — two
      // failures at once, with only one of them visible.
      const { frames, exitCode } = await drive(scenario);
      expect(frames.length, `scenario ${scenario} emitted nothing`).toBeGreaterThan(0);
      for (const frame of frames) {
        const parsed = AssistantHostEventSchema.safeParse(frame);
        expect(parsed.success, `unparseable frame before the crash: ${JSON.stringify(frame)}`).toBe(
          true
        );
      }
      // And it really did die badly — a scenario that exited 0 would not be testing the
      // path this exists for.
      expect(exitCode, "the crash scenario exited cleanly").not.toBe(0);
      // With no shutdown frame: the process simply stops, which is what a crash is.
      expect(frames.some((f) => f.type === "host:shutdown")).toBe(false);
    },
    15_000
  );

  it("stamps a strictly increasing sequence on every frame", async () => {
    const { frames } = await drive("streaming");
    const seqs = frames.map((f) => f.seq as number);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  }, 15_000);

  it("leaves a real gap in the sequence when it drops a frame", async () => {
    // The point of the droppedFrame scenario: the gap must be genuine, so Daintree's
    // detector is exercised rather than mocked. A "gap" that is only a label would
    // let the detector rot untested.
    const { frames } = await drive("droppedFrame");
    const seqs = frames.map((f) => f.seq as number);
    const gaps = seqs.filter((s, i) => i > 0 && s !== seqs[i - 1]! + 1);
    expect(gaps.length, "droppedFrame produced no sequence gap").toBeGreaterThan(0);
  }, 15_000);

  it("sends authoritative content that differs from the streamed tokens", async () => {
    // Guards the guard: if the streamed text and the final content were identical,
    // this scenario could not distinguish a consumer that honours turn:end from one
    // that just concatenates tokens.
    const { frames } = await drive("authoritativeContent");
    const streamed = frames
      .filter((f) => f.type === "turn:token")
      .map((f) => f.chunk as string)
      .join("");
    // The ASSISTANT's end, not the user-turn bracket that precedes every prompt. The
    // user's opens and closes in the same millisecond and carries neither outcome nor
    // content, so `find` on the bare type picks the wrong one.
    const end = frames.find((f) => f.type === "turn:end" && f.outcome !== undefined) as
      { content?: string } | undefined;

    expect(end?.content).toBeTruthy();
    expect(streamed).not.toBe(end?.content);
  }, 15_000);

  it("refuses a protocol version it does not speak", async () => {
    // Mirrors the real engine: a mismatched peer is a hard failure, not a degraded
    // mode. This is the only practical way to exercise Daintree's mismatch path.
    const result = await new Promise<Run>((resolve) => {
      const child = spawn(process.execPath, [ENGINE, "host", "--stdio"], {
        env: { ...process.env, FAKE_ENGINE_SPEED: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const frames: Array<Record<string, unknown>> = [];
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (line) frames.push(JSON.parse(line));
        }
      });
      child.on("exit", (code) => resolve({ frames, stderr: "", exitCode: code }));
      child.stdin.write(
        `${JSON.stringify({
          sessionId: "s",
          windowId: 1,
          projectId: "p",
          cwd: "/tmp",
          tier: "system",
          protocolVersion: 99,
        })}\n`
      );
      setTimeout(() => child.kill("SIGKILL"), 5_000);
    });

    expect(result.frames.some((f) => f.type === "host:error")).toBe(true);
    expect(result.frames.some((f) => f.type === "host:shutdown")).toBe(true);
    expect(result.exitCode).toBe(1);
  }, 15_000);

  it("keeps diagnostics on stderr, never on the protocol stream", async () => {
    const { frames, stderr } = await drive("simple");
    expect(stderr).toContain("fake-assistant-engine");
    // Anything on stdout that is not a frame would be dropped by the host, taking a
    // real event's place in the reader's understanding of the session.
    for (const frame of frames) expect(frame).toHaveProperty("type");
  }, 15_000);

  it("answers an approval while the turn is blocked on it", async () => {
    // The deadlock this guards against is real and was hit while building the fake:
    // if control commands queue behind the running turn, an approval decision can
    // never be delivered — because the turn is blocked WAITING for it.
    const { frames } = await drive("approval", "approved");
    const decided = frames.find((f) => f.type === "approval:decided");
    expect(decided, "the approval was never decided — the engine deadlocked").toBeDefined();
    expect(decided).toMatchObject({ decision: "approved" });
    expect(frames.some((f) => f.type === "turn:end")).toBe(true);
  }, 15_000);

  it("carries a declined approval through to a failed tool", async () => {
    const { frames } = await drive("approval", "rejected");
    const settled = frames.find((f) => f.type === "tool:settled");
    expect(settled).toMatchObject({ result: "error", errorCode: "USER_DECLINED" });
  }, 15_000);
});
