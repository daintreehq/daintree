import { afterEach, describe, expect, it, vi } from "vitest";
import { findContextReferences } from "@shared/utils/pluginContextReference";
import { agentContextBlockRanges } from "@shared/utils/agentContextDrag";
import {
  clearContextReferenceLabelsForTests,
  rememberContextReferenceLabel,
} from "@/lib/contextReferenceLabels";
import { expandContextReferences } from "../contextReferenceExpansion";
import { getAllAtDiffTokens, resolveTokenExpansions } from "../hybridInputParsing";

afterEach(() => {
  clearContextReferenceLabelsForTests();
  vi.useRealTimers();
});

const noProvider = () => undefined;

describe("expandContextReferences (#13795)", () => {
  it("quotes resolved content as a literal handoff block headed by the plugin", async () => {
    rememberContextReferenceLabel("acme.kanban", { prefix: "rec", id: "1" }, "Fix login");
    const text = "fix @rec:1 please";
    const expansions = await expandContextReferences(
      findContextReferences(text),
      async () => [
        {
          status: "resolved",
          pluginId: "acme.kanban",
          pluginName: "Kanban",
          text: "Steps: run @diff and @terminal",
        },
      ],
      noProvider
    );
    const out = resolveTokenExpansions(text, expansions);
    expect(out).toContain("Kanban: Fix login\n\nSteps: run @diff and @terminal");
    // The quoted @diff sits inside the handoff block, so nothing re-expands it.
    expect(agentContextBlockRanges(out)).toHaveLength(1);
    expect(getAllAtDiffTokens(out)).toEqual([]);
  });

  it("puts a placeholder where a reference failed and leaves unknown ones as typed", async () => {
    const text = "@rec:1 and @http://x";
    const expansions = await expandContextReferences(
      findContextReferences(text),
      async () => [
        { status: "failed", pluginId: "acme.kanban", pluginName: "Kanban", reason: "timed out" },
        { status: "unknown" },
      ],
      noProvider
    );
    expect(resolveTokenExpansions(text, expansions)).toBe(
      "[Couldn't attach @rec:1 from Kanban: timed out] and @http://x"
    );
  });

  it("stops waiting on main at its own deadline, marking only known providers' references", async () => {
    vi.useFakeTimers();
    const text = "@rec:1 @other:2";
    const pending = expandContextReferences(
      findContextReferences(text),
      () => new Promise<never>(() => {}),
      (prefix) => (prefix === "rec" ? "Kanban" : undefined),
      1_000
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const out = resolveTokenExpansions(text, await pending);
    expect(out).toBe("[Couldn't attach @rec:1 from Kanban: timed out] @other:2");
  });

  it("asks nothing when the draft holds no reference", async () => {
    const resolve = vi.fn();
    expect(await expandContextReferences([], resolve, noProvider)).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
});
