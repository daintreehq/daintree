import { describe, expect, it, vi } from "vitest";
import {
  batchNotices,
  formatAnswerNotice,
  paneIdentityOf,
  targetOf,
  type QuestionOrigin,
} from "@daintreehq/decisions-client";
import {
  SETUP_CHECK_IMAGE,
  SETUP_CHECK_IMAGE_ID,
  SETUP_DIAGNOSTIC_PANE_PREFIX,
  SetupDiagnostics,
} from "../setupDiagnostic.js";

const AGENT_ORIGIN: QuestionOrigin = {
  host_id: "host_a",
  pane_id: "pane-1",
  terminal_generation: 1,
  ownership_principal: "principal-1",
  agent_incarnation: "0",
  agent_kind: "claude",
  agent_session_id: null,
  project_id: "p1",
  worktree_id: "wt-1",
  worktree_root: "/repo",
  workflow_gate_id: null,
};

/** The library's notice for one answer, preface and all, as delivery hands it to a sink. */
function notice(questionId: string, injectionId: string, label = "Received"): string {
  const block = formatAnswerNotice({
    kind: "answer",
    questionId,
    alias: 3,
    revision: 1,
    source: "human",
    choices: [{ id: "received", label }],
    injectionId,
  });
  return batchNotices([block], Number.MAX_SAFE_INTEGER)[0]!;
}

describe("SetupDiagnostics", () => {
  it("opens a terminal whose identity no agent pane can have", () => {
    const diagnostics = new SetupDiagnostics();
    const first = diagnostics.open("host_a", () => {});
    const second = diagnostics.open("host_a", () => {});

    expect(first.origin.pane_id.startsWith(SETUP_DIAGNOSTIC_PANE_PREFIX)).toBe(true);
    expect(diagnostics.handles(first.origin.pane_id)).toBe(true);
    expect(diagnostics.handles(AGENT_ORIGIN.pane_id)).toBe(false);
    expect(second.origin.pane_id).not.toBe(first.origin.pane_id);
    expect(second.origin.ownership_principal).not.toBe(first.origin.ownership_principal);
    // Opening another closes the one before it.
    expect(first.isOpen).toBe(false);
    expect(diagnostics.isCurrent(paneIdentityOf(first.origin))).toBe(false);
    expect(diagnostics.isCurrent(paneIdentityOf(second.origin))).toBe(true);
  });

  it("is found only at its exact run, and idle only while open", async () => {
    const diagnostics = new SetupDiagnostics();
    const terminal = diagnostics.open("host_a", () => {});

    await expect(diagnostics.sink.locate(terminal.origin)).resolves.toEqual({
      state: "alive",
      target: targetOf(terminal.origin),
    });
    await expect(diagnostics.sink.isIdle(targetOf(terminal.origin))).resolves.toBe(true);
    terminal.expect("q_setup_check");
    for (const other of [
      { ownership_principal: "someone-else" },
      { terminal_generation: 2 },
      { host_id: "host_b" },
      { agent_incarnation: "1" },
    ]) {
      const wrong = { ...terminal.origin, ...other };
      const label = JSON.stringify(other);
      await expect(diagnostics.sink.locate(wrong), label).resolves.toEqual({ state: "gone" });
      await expect(diagnostics.sink.isIdle(targetOf(wrong)), label).resolves.toBe(false);
      await expect(
        diagnostics.sink.inject(
          targetOf(wrong),
          notice("q_setup_check", "inj_0123456789"),
          "inj_0123456789"
        ),
        label
      ).resolves.toEqual({ outcome: "unavailable", reason: "gone" });
    }
    // Nothing reached the terminal through a wrong target.
    expect(terminal.view()!.screen).toBe("");

    diagnostics.close(terminal);
    await expect(diagnostics.sink.locate(terminal.origin)).resolves.toEqual({ state: "gone" });
    await expect(diagnostics.sink.isIdle(targetOf(terminal.origin))).resolves.toBe(false);
  });

  it("types its own question's answer as Daintree renders it, and reports it delivered", async () => {
    const onChange = vi.fn();
    const diagnostics = new SetupDiagnostics();
    const terminal = diagnostics.open("host_a", onChange);
    terminal.expect("q_setup_check");
    const target = targetOf(terminal.origin);

    const result = await diagnostics.sink.inject(
      target,
      notice("q_setup_check", "inj_0123456789"),
      "inj_0123456789"
    );

    expect(result).toEqual({ outcome: "delivered", proof: "setup-diagnostic:inj_0123456789" });
    expect(onChange).toHaveBeenCalledOnce();
    const view = terminal.view()!;
    expect(view.screen).toContain("question_id: q_setup_check (q-3)");
    expect(view.screen).toContain("choice_label: Received");
    expect(view.screen).toContain("inj_0123456789");
    expect(terminal.answerTypedFor("q_setup_check")).toMatchObject({
      source: "human",
      expired: false,
      injectionId: "inj_0123456789",
    });
    await expect(diagnostics.sink.hasMarker(target, "inj_0123456789")).resolves.toBe(true);
    await expect(diagnostics.sink.hasMarker(target, "inj_9999999999")).resolves.toBe(false);
  });

  it("counts only a person's answer as answered, never an expiry notice", async () => {
    const diagnostics = new SetupDiagnostics();
    const terminal = diagnostics.open("host_a", () => {});
    terminal.expect("q_setup_check");
    const expiry = batchNotices(
      [
        formatAnswerNotice({
          kind: "expired",
          questionId: "q_setup_check",
          revision: 1,
          source: "human",
          injectionId: "inj_expired_01",
        }),
      ],
      Number.MAX_SAFE_INTEGER
    )[0]!;

    await expect(
      diagnostics.sink.inject(targetOf(terminal.origin), expiry, "inj_expired_01")
    ).resolves.toMatchObject({ outcome: "delivered" });

    expect(terminal.answerTypedFor("q_setup_check")).toBeUndefined();
  });

  it("refuses another question's answer, a notice for another injection, and text that isn't one", async () => {
    const diagnostics = new SetupDiagnostics();
    const terminal = diagnostics.open("host_a", () => {});
    const target = targetOf(terminal.origin);
    const rejected = { outcome: "unavailable", reason: "rejected", detail: "invalid-notice" };

    // Nothing is taken before the terminal knows its question.
    await expect(
      diagnostics.sink.inject(target, notice("q_setup_check", "inj_0123456789"), "inj_0123456789")
    ).resolves.toEqual(rejected);
    terminal.expect("q_setup_check");
    await expect(
      diagnostics.sink.inject(target, notice("q_other_check", "inj_0123456789"), "inj_0123456789")
    ).resolves.toEqual(rejected);
    await expect(
      diagnostics.sink.inject(target, notice("q_setup_check", "inj_0123456789"), "inj_another_one")
    ).resolves.toEqual(rejected);
    await expect(diagnostics.sink.inject(target, "rm -rf /\r", "inj_0123456789")).resolves.toEqual(
      rejected
    );
    expect(terminal.view()!.screen).toBe("");
  });

  it("types nothing into a closed terminal, and forgets its screen", async () => {
    const diagnostics = new SetupDiagnostics();
    const terminal = diagnostics.open("host_a", () => {});
    terminal.expect("q_setup_check");
    const target = targetOf(terminal.origin);
    await diagnostics.sink.inject(
      target,
      notice("q_setup_check", "inj_0123456789"),
      "inj_0123456789"
    );

    diagnostics.close(terminal);

    expect(terminal.view()).toBeNull();
    // Its screen went with it, not just out of view.
    expect(terminal.hasMarker("inj_0123456789")).toBe(false);
    expect(terminal.isOpen).toBe(false);
    await expect(
      diagnostics.sink.inject(target, notice("q_setup_check", "inj_0123456780"), "inj_0123456780")
    ).resolves.toEqual({ outcome: "unavailable", reason: "gone" });
    await expect(diagnostics.sink.hasMarker(target, "inj_0123456789")).resolves.toBe(false);
  });

  it("gives a diagnostic origin its own image alone, and every other origin to the worktree resolver", async () => {
    const diagnostics = new SetupDiagnostics();
    const worktree = { resolve: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]) })) };
    const resolver = diagnostics.attachmentResolver(worktree);
    const terminal = diagnostics.open("host_a", () => {});

    const image = await resolver.resolve(terminal.origin, SETUP_CHECK_IMAGE_ID);
    expect(image?.bytes).toEqual(SETUP_CHECK_IMAGE);
    await expect(resolver.resolve(terminal.origin, "screenshot.png")).resolves.toBeNull();
    await expect(
      resolver.resolve(
        { ...terminal.origin, ownership_principal: "someone-else" },
        SETUP_CHECK_IMAGE_ID
      )
    ).resolves.toBeNull();
    expect(worktree.resolve).not.toHaveBeenCalled();

    await expect(resolver.resolve(AGENT_ORIGIN, SETUP_CHECK_IMAGE_ID)).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(worktree.resolve).toHaveBeenCalledExactlyOnceWith(AGENT_ORIGIN, SETUP_CHECK_IMAGE_ID);

    diagnostics.close(terminal);
    await expect(resolver.resolve(terminal.origin, SETUP_CHECK_IMAGE_ID)).resolves.toBeNull();
  });
});
