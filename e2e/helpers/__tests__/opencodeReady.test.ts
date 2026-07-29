import { describe, it, expect } from "vitest";
import {
  DEFAULT_STABILIZATION_POLICY,
  OPENCODE_CRASH_SIGNATURE,
  areOpenCodeOutputsEquivalent,
  classifyOpenCodeOutput,
  formatOpenCodeCrashError,
  formatOpenCodeTimeoutError,
  formatTerminalTail,
  initialStabilizationState,
  normalizeOpenCodeOutput,
  observeOpenCodeOutput,
  type StabilizationPolicy,
} from "../opencodeReady";

// Covers the #11476 online-gate logic. The value of these tests is the
// false-positive boundary on the fatal detector: the online suite gates release
// publishes, so a detector that fires on a recoverable upstream error would
// fail releases that should pass — strictly worse than the timeout it replaces.

const TEST_POLICY: StabilizationPolicy = { requiredSamples: 3, maxWaitMs: 1_000 };

describe("classifyOpenCodeOutput — fatal parser crash", () => {
  it("detects the crash when the message wraps mid-word across terminal rows", () => {
    // getTerminalText joins one string per terminal ROW, so a row break can
    // land anywhere — including inside a word. A whitespace-tolerant regex
    // would miss these; only whitespace-collapsed comparison catches them.
    const splits = [
      "error: Invalid key name: key name can\nnot be empty",
      "error: Invalid key na\nme: key name cannot be empty",
      "error: Invalid key name: key name cannot be em\npty",
    ];

    for (const text of splits) {
      expect(classifyOpenCodeOutput(text).kind, text).toBe("crashed");
    }
  });

  it("is case-insensitive and tolerates collapsed or padded spacing", () => {
    expect(classifyOpenCodeOutput("INVALID KEY NAME: KEY NAME CANNOT BE EMPTY").kind).toBe(
      "crashed"
    );
    expect(classifyOpenCodeOutput("Invalid  key   name:key name cannot be empty").kind).toBe(
      "crashed"
    );
  });

  it("reports the canonical signature regardless of the casing observed", () => {
    const result = classifyOpenCodeOutput("invalid key name: key name cannot be empty");
    expect(result).toEqual({ kind: "crashed", signature: OPENCODE_CRASH_SIGNATURE });
  });

  it("outranks ready text left in the buffer above the crash", () => {
    const text = ["> Ask anything", "", "error: Invalid key name: key name cannot be empty"].join(
      "\n"
    );
    expect(classifyOpenCodeOutput(text).kind).toBe("crashed");
  });

  it("does not fire on recoverable keymap errors or on either half alone", () => {
    const nonFatal = [
      "[Keymap] Error resolving command binding",
      "[Keymap] Error: sequence pattern match failed",
      "error: Invalid key name: ctrl+",
      "Invalid key name",
      "key name cannot be empty",
      "warn: key name cannot be resolved",
      "Invalid key binding: key name cannot be empty",
    ];

    for (const text of nonFatal) {
      expect(classifyOpenCodeOutput(text).kind, text).not.toBe("crashed");
    }
  });
});

describe("classifyOpenCodeOutput — precedence", () => {
  it("prefers needs-restart over ready markers painted in the same buffer", () => {
    const text = "Update complete. Please restart the application.\n> Ask anything";
    expect(classifyOpenCodeOutput(text).kind).toBe("needs-restart");
  });

  it("prefers the api-key prompt over the provider match it contains", () => {
    // A key prompt names the provider it wants a key for, so a provider-first
    // order would send Enter where the flow needs ArrowUp + Enter.
    const text = "Select provider: Anthropic\nPaste your API key to continue";
    expect(classifyOpenCodeOutput(text).kind).toBe("awaiting-api-key");
  });

  it("recognizes each ready marker independently", () => {
    expect(classifyOpenCodeOutput("> Ask anything").kind).toBe("ready");
    expect(classifyOpenCodeOutput("build opencode").kind).toBe("ready");
    expect(classifyOpenCodeOutput("  1.18.9  ").kind).toBe("ready");
  });

  it("falls through to pending for unrelated startup chatter", () => {
    expect(classifyOpenCodeOutput("").kind).toBe("pending");
    expect(classifyOpenCodeOutput("Starting up...").kind).toBe("pending");
  });

  it("treats /connect as a provider prompt", () => {
    expect(classifyOpenCodeOutput("run /connect to continue").kind).toBe("awaiting-provider");
  });
});

describe("normalizeOpenCodeOutput", () => {
  it("ignores line-ending, trailing-padding and trailing-blank-line differences", () => {
    expect(areOpenCodeOutputsEquivalent("a\r\nb", "a\nb")).toBe(true);
    expect(areOpenCodeOutputsEquivalent("a   \nb\t", "a\nb")).toBe(true);
    expect(areOpenCodeOutputsEquivalent("a\nb\n\n\n", "a\nb")).toBe(true);
  });

  it("treats braille and circle spinner frames as one animation", () => {
    expect(areOpenCodeOutputsEquivalent("⠋ working", "⠙ working")).toBe(true);
    expect(areOpenCodeOutputsEquivalent("◐ working", "◓ working")).toBe(true);
  });

  it("keeps ASCII slash/pipe/dash distinct so paths are not collapsed", () => {
    // Folding the ASCII spinner set would make genuinely different screens
    // compare equal; unrecognized spinners are covered by maxWaitMs instead.
    expect(areOpenCodeOutputsEquivalent("/Users/a", "|Users|a")).toBe(false);
    expect(areOpenCodeOutputsEquivalent("a-b", "a/b")).toBe(false);
  });

  it("still reports substantive text changes as different", () => {
    expect(areOpenCodeOutputsEquivalent("⠋ loading model", "⠙ loading plugins")).toBe(false);
    expect(normalizeOpenCodeOutput("a\nb")).not.toBe(normalizeOpenCodeOutput("a\nc"));
  });
});

describe("observeOpenCodeOutput", () => {
  const drive = (
    samples: Array<{ kind: Parameters<typeof observeOpenCodeOutput>[1]["kind"]; text: string }>,
    stepMs = 100
  ) => {
    let state = initialStabilizationState();
    const decisions: string[] = [];
    samples.forEach((sample, i) => {
      const result = observeOpenCodeOutput(
        state,
        { kind: sample.kind, text: sample.text, now: i * stepMs },
        TEST_POLICY
      );
      state = result.state;
      decisions.push(result.decision);
    });
    return decisions;
  };

  it("withholds input until the required run of equivalent snapshots", () => {
    const decisions = drive(
      Array.from({ length: 4 }, () => ({ kind: "awaiting-provider" as const, text: "provider" }))
    );
    expect(decisions).toEqual(["wait", "wait", "act", "act"]);
  });

  it("restarts the run when the prompt text changes materially", () => {
    const decisions = drive([
      { kind: "awaiting-provider", text: "provider a" },
      { kind: "awaiting-provider", text: "provider a" },
      { kind: "awaiting-provider", text: "provider b" },
      { kind: "awaiting-provider", text: "provider b" },
      { kind: "awaiting-provider", text: "provider b" },
    ]);
    expect(decisions).toEqual(["wait", "wait", "wait", "wait", "act"]);
  });

  it("acts once maxWaitMs elapses even if the screen never settles", () => {
    // An animation we do not recognize repaints forever; without the cap the
    // gate would hold input until the ready deadline expired.
    const decisions = drive(
      Array.from({ length: 12 }, (_, i) => ({
        kind: "awaiting-provider" as const,
        text: `frame ${i}`,
      }))
    );
    expect(decisions.slice(0, 10)).toEqual(Array(10).fill("wait"));
    expect(decisions[10]).toBe("act");
  });

  it("resets the elapsed cap when the prompt kind changes", () => {
    let state = initialStabilizationState();
    for (let i = 0; i < 10; i++) {
      state = observeOpenCodeOutput(
        state,
        { kind: "awaiting-provider", text: `frame ${i}`, now: i * 100 },
        TEST_POLICY
      ).state;
    }

    const switched = observeOpenCodeOutput(
      state,
      { kind: "awaiting-api-key", text: "api key", now: 1_000 },
      TEST_POLICY
    );
    expect(switched.decision).toBe("wait");
    expect(switched.state.sampleCount).toBe(1);
  });

  it("clears accumulated progress for non-actionable output", () => {
    let state = initialStabilizationState();
    state = observeOpenCodeOutput(
      state,
      { kind: "awaiting-provider", text: "provider", now: 0 },
      TEST_POLICY
    ).state;

    const cleared = observeOpenCodeOutput(
      state,
      { kind: "pending", text: "loading", now: 100 },
      TEST_POLICY
    );
    expect(cleared.decision).toBe("not-actionable");
    expect(cleared.state).toEqual(initialStabilizationState());
  });

  it("leaves the sample streak reachable under the shipped policy", () => {
    // If the elapsed cap could expire before requiredSamples polls complete at
    // the driver's 500ms cadence, the settle path would be dead code and every
    // prompt would fall through to the fallback.
    const pollMs = 500;
    expect((DEFAULT_STABILIZATION_POLICY.requiredSamples - 1) * pollMs).toBeLessThan(
      DEFAULT_STABILIZATION_POLICY.maxWaitMs
    );
  });
});

describe("failure diagnostics", () => {
  it("attributes the crash upstream and points at the pin to bump", () => {
    const message = formatOpenCodeCrashError(OPENCODE_CRASH_SIGNATURE, "boom");
    expect(message).toContain(OPENCODE_CRASH_SIGNATURE);
    expect(message).toContain("not a Daintree ready-state regression");
    expect(message).toContain("scripts/ci/install-opencode.mjs");
    expect(message).toContain("boom");
  });

  it("names the last classification in the timeout so the failure is triageable", () => {
    const message = formatOpenCodeTimeoutError("awaiting-provider", "provider prompt");
    expect(message).toContain("awaiting-provider");
    expect(message).toContain("provider prompt");
  });

  it("omits the tail section entirely when there is no output to show", () => {
    expect(formatOpenCodeTimeoutError("pending", "   \n\n")).not.toContain("Terminal tail");
  });

  it("keeps only the most recent lines, and truncates from the front on overflow", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const tail = formatTerminalTail(text, { maxLines: 5 });
    expect(tail.split("\n")).toHaveLength(5);
    expect(tail).toContain("line 49");
    expect(tail).not.toContain("line 44");

    const wide = Array.from({ length: 10 }, () => "x".repeat(100)).join("\n");
    const capped = formatTerminalTail(wide, { maxLines: 10, maxChars: 250 });
    expect(capped).toHaveLength(250);
    expect(wide.endsWith(capped)).toBe(true);
  });
});
