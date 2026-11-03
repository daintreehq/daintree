import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmissionOutputLedger } from "../SubmissionOutputLedger.js";
import {
  MAX_RETAINED_SUBMISSIONS,
  SUBMISSION_OUTPUT_MAX_BYTES,
  SUBMISSION_OUTPUT_RETENTION_MS,
} from "../../../../shared/types/terminalSubmission.js";

const capturing = (text: string) => ({ text, truncated: false, state: "capturing" as const });

afterEach(() => {
  vi.useRealTimers();
});

describe("SubmissionOutputLedger", () => {
  it("holds what a capture publishes, redacted, by its token", () => {
    const ledger = new SubmissionOutputLedger();
    const id = ledger.begin("tok");
    const key = `AKIA${"B".repeat(16)}`;
    ledger.publish(id, capturing(`the key is ${key}`));

    const output = ledger.read("tok")!;
    expect(output.text.startsWith("the key is ")).toBe(true);
    expect(output.text).not.toContain(key);
    ledger.dispose();
  });

  it("keeps a final output and ignores anything published after it", () => {
    const ledger = new SubmissionOutputLedger();
    const id = ledger.begin("tok");
    ledger.publish(id, { text: "done", truncated: true, state: "closed" });
    ledger.publish(id, capturing("later"));
    expect(ledger.read("tok")).toEqual({ text: "done", truncated: true, state: "closed" });
    ledger.dispose();
  });

  it("flags redacted text that outgrew the byte cap, keeping its start, and stays open to a replacement", () => {
    const ledger = new SubmissionOutputLedger();
    const id = ledger.begin("tok");
    // Short enough raw, past the cap once each value becomes a longer marker.
    const raw = `first line\n${Array.from({ length: 1100 }, () => "password: abc").join("\n")}`;
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(SUBMISSION_OUTPUT_MAX_BYTES);
    ledger.publish(id, capturing(raw));

    const output = ledger.read("tok")!;
    expect(output.text.startsWith("first line\npassword: [redacted]")).toBe(true);
    expect(output.text).not.toContain("abc");
    expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(SUBMISSION_OUTPUT_MAX_BYTES);
    expect(output).toMatchObject({ truncated: true, state: "capturing" });
    // A replay that lines up with the real answer replaces it.
    ledger.publish(id, capturing("the real answer"));
    expect(ledger.read("tok")).toEqual(capturing("the real answer"));
    ledger.dispose();
  });

  it("drops a capture 24 hours after its Enter, read or not", () => {
    vi.useFakeTimers();
    const ledger = new SubmissionOutputLedger();
    const id = ledger.begin("tok");
    ledger.publish(id, capturing("answer"));

    vi.advanceTimersByTime(SUBMISSION_OUTPUT_RETENTION_MS - 1);
    expect(ledger.read("tok")?.text).toBe("answer");
    vi.advanceTimersByTime(1);
    // Let go of without a read: the timer, not the next lookup, drops it.
    expect((ledger as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
    expect(ledger.read("tok")).toBeUndefined();
    // Gone from memory, so a publish for it lands nowhere.
    ledger.publish(id, capturing("again"));
    expect(ledger.read("tok")).toBeUndefined();
    ledger.dispose();
  });

  it("keeps only as many captures as the submission ledger keeps records", () => {
    const ledger = new SubmissionOutputLedger();
    const first = ledger.begin("tok-0");
    for (let index = 1; index <= MAX_RETAINED_SUBMISSIONS; index += 1) ledger.begin(`tok-${index}`);
    expect(ledger.read("tok-0")).toBeUndefined();
    expect(ledger.read(`tok-${MAX_RETAINED_SUBMISSIONS}`)).toBeDefined();
    ledger.publish(first, capturing("evicted"));
    expect(ledger.read("tok-0")).toBeUndefined();
    ledger.dispose();
  });

  it("starts over when a token is reused, ignoring the old capture", () => {
    const ledger = new SubmissionOutputLedger();
    const old = ledger.begin("tok");
    ledger.begin("tok");
    ledger.publish(old, capturing("old"));
    expect(ledger.read("tok")?.text).toBe("");
    ledger.dispose();
  });

  it("never reuses a capture id across ledgers", () => {
    const first = new SubmissionOutputLedger();
    const second = new SubmissionOutputLedger();
    const a = first.begin("tok");
    const b = second.begin("tok");
    expect(b).not.toBe(a);
    second.publish(a, capturing("from the other terminal"));
    expect(second.read("tok")?.text).toBe("");
    first.dispose();
    second.dispose();
  });
});
