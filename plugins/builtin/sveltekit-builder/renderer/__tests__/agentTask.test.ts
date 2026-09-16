import { describe, expect, it } from "vitest";
import { buildAgentTaskPrompt, deliveryFromPhase, isAgentBusy, taskScopes } from "../agentTask.js";
import { FILE, makeSelection } from "./testHost.js";

describe("buildAgentTaskPrompt", () => {
  it("leads with the user's words and names the source the element came from", () => {
    const prompt = buildAgentTaskPrompt({
      instruction: "  Make this button say Upgrade  ",
      selection: makeSelection(),
      file: `apps/site/${FILE}`,
      worktreePath: "/repo",
      excerpt: { text: '<button class="px-6">Start Pro</button>', firstLine: 5 },
    });

    expect(prompt.split("\n")[0]).toBe("Make this button say Upgrade");
    expect(prompt).toContain(`- Source: <button> at apps/site/${FILE}:6:3`);
    expect(prompt).toContain("- Current classes: px-6 py-3 rounded-lg");
    expect(prompt).toContain('- Current text: "Start Pro"');
    expect(prompt).toContain(`(apps/site/${FILE}, lines 5–5)`);
  });

  it("keeps generated frames out of the component chain", () => {
    const prompt = buildAgentTaskPrompt({
      instruction: "Tighten the spacing",
      selection: makeSelection(),
      file: FILE,
      worktreePath: null,
      excerpt: null,
    });

    expect(prompt).toContain("- Rendered inside: PricingCard (src/lib/PricingCard.svelte:3)");
    expect(prompt).not.toContain(".svelte-kit/generated");
    expect(prompt).not.toContain("Source around it");
  });

  it("carries every selected element, not only the first", () => {
    const base = makeSelection();
    const first = base.nodes[0]!;
    const second = {
      ...first,
      runtimeOccurrenceId: "occ-2",
      label: 'button "Start Team"',
      definition: { ...first.definition!, location: { file: FILE, line: 9, column: 4 } },
    };
    const prompt = buildAgentTaskPrompt({
      instruction: "Make these match",
      selection: { ...base, nodes: [first, second] },
      file: FILE,
      worktreePath: null,
      excerpt: null,
    });

    expect(prompt).toContain(`- Also selected: button "Start Team" (${FILE}:9:5)`);
  });

  it("warns when the markup draws more than one copy", () => {
    const prompt = buildAgentTaskPrompt({
      instruction: "Change the label",
      selection: makeSelection({ renderedOccurrences: 3 }),
      file: FILE,
      worktreePath: null,
      excerpt: null,
    });

    expect(prompt).toContain("renders 3 copies on the page");
  });

  it("says the source wasn't traced rather than inventing a location", () => {
    const selection = makeSelection({ node: { definition: null } });
    const prompt = buildAgentTaskPrompt({
      instruction: "Change it",
      selection,
      file: null,
      worktreePath: null,
      excerpt: { text: "ignored", firstLine: 1 },
    });

    expect(prompt).toContain("- Source: not traced");
    expect(prompt).not.toContain("Source around it");
  });
});

describe("delivery", () => {
  it("claims sent only once the whole prompt reached the pty", () => {
    expect(deliveryFromPhase("pty_written")).toEqual({ status: "sent" });
    expect(deliveryFromPhase("queued")).toBeNull();
    expect(deliveryFromPhase("writing")).toBeNull();
    expect(deliveryFromPhase("unknown")).toEqual({ status: "unconfirmed" });
    expect(deliveryFromPhase("failed")?.status).toBe("failed");
    expect(deliveryFromPhase("cancelled")?.status).toBe("failed");
  });

  it("treats a mid-turn agent as busy and a waiting one as reachable", () => {
    expect(isAgentBusy("working")).toBe(true);
    expect(isAgentBusy("directing")).toBe(true);
    expect(isAgentBusy("waiting")).toBe(false);
    expect(isAgentBusy("idle")).toBe(false);
    expect(isAgentBusy(null)).toBe(false);
  });
});

const CARD = "src/lib/PricingCard.svelte";

// Innermost first, as the guest reads Svelte's parent chain: the button is
// written in PricingCard, which the pricing page uses inside an each block, and
// generated code renders the page.
function nestedSelection() {
  const base = makeSelection();
  const node = base.nodes[0]!;
  return makeSelection({
    node: {
      definition: { ...node.definition!, location: { file: CARD, line: 4, column: 2 } },
      ancestry: [
        {
          kind: "component",
          location: { file: FILE, line: 6, column: 4 },
          componentTag: "PricingCard",
          generated: false,
        },
        { kind: "each", location: { file: FILE, line: 5, column: 2 }, generated: false },
        {
          kind: "component",
          location: { file: ".svelte-kit/generated/root.svelte", line: 1, column: 0 },
          generated: true,
        },
      ],
    },
  });
}

describe("taskScopes", () => {
  it("offers the element, each component around it, and the file at the top", () => {
    const scopes = taskScopes(nestedSelection());

    expect(scopes.map((scope) => scope.label)).toEqual([
      'button "Start Pro"',
      "PricingCard",
      "+page.svelte",
    ]);
    expect(scopes[1]).toEqual({
      kind: "component",
      label: "PricingCard",
      file: CARD,
      usedAt: { file: FILE, line: 6 },
    });
    expect(scopes[2]).toEqual({
      kind: "component",
      label: "+page.svelte",
      file: FILE,
      usedAt: null,
    });
  });

  it("frames a component request around the component, not the clicked element", () => {
    const selection = nestedSelection();
    const prompt = buildAgentTaskPrompt({
      instruction: "Add a badge",
      selection,
      file: `apps/site/${CARD}`,
      worktreePath: null,
      excerpt: null,
      scope: taskScopes(selection)[1],
    });

    expect(prompt).toContain(
      `- Target: the PricingCard component (apps/site/${CARD}, used at apps/site/${FILE}:6)`
    );
    expect(prompt).toContain("Keep the change inside the PricingCard component");
  });
});
