import { describe, expect, it } from "vitest";
import {
  buildAgentTaskPrompt,
  callSiteKey,
  componentCallSites,
  scopesFor,
  isAgentBusy,
  taskScopes,
} from "../agentTask.js";
import { FILE, makeSelection } from "./testHost.js";

describe("buildAgentTaskPrompt", () => {
  it("leads with the user's words and names the source the element came from", () => {
    const prompt = buildAgentTaskPrompt({
      instruction: "  Make this button say Upgrade  ",
      selection: makeSelection(),
      file: `apps/site/${FILE}`,
      worktreePath: "/repo",
      place: null,
    });

    expect(prompt.split("\n")[0]).toBe("Make this button say Upgrade");
    expect(prompt).toContain(`- Source: <button> at apps/site/${FILE}:6:3`);
  });

  it("separates the user's words from what the builder added with a rule", () => {
    // The rule: an agent reading the prompt can tell the request from its
    // context without inferring the boundary from a blank line. Asserted by
    // position — the instruction is everything above the rule, the builder's
    // context everything below — so the wording of either half can change
    // without touching this.
    const prompt = buildAgentTaskPrompt({
      instruction: "Make this button say Upgrade",
      selection: makeSelection(),
      file: FILE,
      worktreePath: "/repo",
      place: null,
    });

    const lines = prompt.split("\n");
    const rule = lines.indexOf("---");
    expect(rule).toBeGreaterThan(0);
    expect(lines.slice(0, rule).join("\n").trim()).toBe("Make this button say Upgrade");
    expect(lines.slice(rule + 1).join("\n")).toContain("Daintree Site Builder");
    // A blank line each side, so it is a Markdown rule and not a setext
    // underline for the sentence above it.
    expect(lines[rule - 1]).toBe("");
    expect(lines[rule + 1]).toBe("");
  });

  it("references files instead of pasting their contents", () => {
    const prompt = buildAgentTaskPrompt({
      instruction: "Make this button say Upgrade",
      selection: makeSelection(),
      file: FILE,
      worktreePath: "/repo",
      place: null,
    });

    expect(prompt).toContain("file references only; read the files for the code");
    expect(prompt).not.toContain("```");
    expect(prompt).not.toContain("Current classes");
    expect(prompt).not.toContain("Current text");
    expect(prompt).not.toContain("px-6 py-3");
  });

  it("names the app, its toolchain and the route files around the page, outermost first", () => {
    const prompt = buildAgentTaskPrompt({
      instruction: "Tighten the header",
      selection: { ...makeSelection(), appRoot: "/repo/apps/site", displayedUrl: "/pricing" },
      file: `apps/site/${FILE}`,
      worktreePath: "/repo",
      place: {
        appPath: "apps/site",
        versions: { svelte: "5.2.0", kit: "2.15.0", tailwind: null },
        route: {
          routeId: "/pricing",
          pageFile: `apps/site/${FILE}`,
          layoutFiles: [
            "apps/site/src/routes/+layout.svelte",
            "apps/site/src/routes/pricing/+layout.svelte",
          ],
          dataFiles: [
            "apps/site/src/routes/+layout.server.ts",
            "apps/site/src/routes/pricing/+page.ts",
          ],
          dynamic: false,
          endpointOnly: false,
        },
      },
    });

    expect(prompt).toContain("- App: apps/site (SvelteKit 2.15.0, Svelte 5.2.0, no Tailwind)");
    expect(prompt).toContain("- Page: /pricing (route /pricing)");
    // A toolchain the bundled compiler was tested against is unremarkable, so
    // the prompt spends no line on it.
    expect(prompt).not.toContain("Toolchain note:");
    const files = prompt.slice(prompt.indexOf("- Route files, outermost layout first:"));
    expect(files.split("\n").slice(1, 6)).toEqual([
      "  - layout: apps/site/src/routes/+layout.svelte",
      "  - layout: apps/site/src/routes/pricing/+layout.svelte",
      "  - data: apps/site/src/routes/+layout.server.ts",
      "  - data: apps/site/src/routes/pricing/+page.ts",
      `  - page: apps/site/${FILE}`,
    ]);
  });

  it("warns about a toolchain the traced locations were not proven against", () => {
    const prompt = buildAgentTaskPrompt({
      instruction: "Tighten the header",
      selection: makeSelection(),
      file: FILE,
      worktreePath: "/repo",
      place: {
        appPath: "",
        versions: { svelte: "4.2.1", kit: "2.15.0", tailwind: null },
        route: null,
      },
    });

    // The agent is told what to distrust and what to do about it — check the
    // file — not that the builder has withheld anything.
    expect(prompt).toContain("- Toolchain note: Svelte 4.2.1 (tested against Svelte 5)");
    expect(prompt).toContain("verify the source before relying on them");
    expect(prompt).not.toMatch(/preview[- ]only/i);
  });

  it("keeps generated frames out of the component chain", () => {
    const prompt = buildAgentTaskPrompt({
      instruction: "Tighten the spacing",
      selection: makeSelection(),
      file: FILE,
      worktreePath: null,
      place: null,
    });

    expect(prompt).toContain("- Rendered inside: PricingCard (src/lib/PricingCard.svelte:3)");
    expect(prompt).not.toContain(".svelte-kit/generated");
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
      place: null,
    });

    expect(prompt).toContain(`- Also selected: button "Start Team" (${FILE}:9:5)`);
  });

  it("warns when the markup draws more than one copy", () => {
    const prompt = buildAgentTaskPrompt({
      instruction: "Change the label",
      selection: makeSelection({ renderedOccurrences: 3 }),
      file: FILE,
      worktreePath: null,
      place: null,
    });

    expect(prompt).toContain("renders 3 copies on the page");
  });

  it("says a count is only a floor when the page was too large to count", () => {
    const selection = makeSelection({ renderedOccurrences: 1 });
    selection.nodes[0]!.definition!.renderedOccurrencesAtLeast = true;
    const prompt = buildAgentTaskPrompt({
      instruction: "Change the label",
      selection,
      file: FILE,
      worktreePath: null,
      place: null,
    });
    expect(prompt).toContain(
      "renders at least 1 copy on the page (the page could not count them all)"
    );
  });

  it("says the source wasn't traced rather than inventing a location", () => {
    const selection = makeSelection({ node: { definition: null } });
    const prompt = buildAgentTaskPrompt({
      instruction: "Change it",
      selection,
      file: null,
      worktreePath: null,
      place: null,
    });

    expect(prompt).toContain("- Source: not traced");
  });
});

describe("agent activity", () => {
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

const CARD_SITE = { file: FILE, line: 6, column: 4 };
const RESOLVED = { [callSiteKey(CARD_SITE)]: CARD };

describe("taskScopes", () => {
  it("offers the element, each component around it, and the file at the top", () => {
    const scopes = taskScopes(nestedSelection(), RESOLVED);

    expect(scopes.map((scope) => scope.label)).toEqual([
      'button "Start Pro"',
      "PricingCard",
      "+page.svelte",
    ]);
    expect(scopes[1]).toEqual({
      kind: "component",
      label: "PricingCard",
      file: CARD,
      usedAt: CARD_SITE,
    });
    expect(scopes[2]).toEqual({
      kind: "component",
      label: "+page.svelte",
      file: FILE,
      usedAt: null,
    });
  });

  it("never infers a component's file from the element or its neighbours", () => {
    // Pending, and then proven unknowable: both leave the file unnamed.
    expect(taskScopes(nestedSelection())[1]).toMatchObject({ label: "PricingCard", file: null });
    const unknown = { [callSiteKey(CARD_SITE)]: null };
    expect(taskScopes(nestedSelection(), unknown)[1]).toMatchObject({ file: null });
  });

  it("keeps the element as a scope when the source wasn't traced", () => {
    const scopes = taskScopes(makeSelection({ node: { definition: null } }));
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.kind).toBe("element");
  });

  it("cites authored call sites beyond a library frame, as the prompt does", () => {
    const base = nestedSelection();
    const node = base.nodes[0]!;
    const outer = { file: FILE, line: 2, column: 0 };
    const selection = makeSelection({
      node: {
        ...node,
        ancestry: [
          node.ancestry[0]!,
          {
            kind: "component",
            location: { file: "node_modules/ui/Shell.svelte", line: 1, column: 0 },
            generated: true,
          },
          { kind: "component", location: outer, componentTag: "Layout", generated: false },
        ],
      },
    });
    expect(componentCallSites(selection, null)).toEqual([CARD_SITE, outer]);
  });

  it("asks main about every call site on the chain and the picked one, once each", () => {
    const outside = { file: ".svelte-kit/generated/root.svelte", line: 1, column: 0, name: "Page" };
    expect(componentCallSites(nestedSelection(), { ...CARD_SITE, name: "PricingCard" })).toEqual([
      CARD_SITE,
    ]);
    expect(componentCallSites(nestedSelection(), outside)).toEqual([
      CARD_SITE,
      { file: outside.file, line: 1, column: 0 },
    ]);
  });

  it("frames a component request around the component, not the clicked element", () => {
    const selection = nestedSelection();
    const prompt = buildAgentTaskPrompt({
      instruction: "Add a badge",
      selection,
      file: `apps/site/${CARD}`,
      worktreePath: null,
      place: null,
      scope: taskScopes(selection, RESOLVED)[1],
    });

    expect(prompt).toContain(
      `- Target: the PricingCard component (apps/site/${CARD}, used at apps/site/${FILE}:6)`
    );
    expect(prompt).toContain("Keep the change inside the PricingCard component");
  });
  it("places a visual-only component's files inside a monorepo app", () => {
    const selection = {
      ...makeSelection({ node: { definition: null } }),
      appRoot: "/repo/apps/site",
    };
    const prompt = buildAgentTaskPrompt({
      instruction: "Animate the chart",
      selection,
      file: null,
      worktreePath: "/repo",
      place: null,
      scope: {
        kind: "component",
        label: "Chart",
        file: "src/lib/Chart.svelte",
        usedAt: { file: FILE, line: 3, column: 2 },
      },
    });
    expect(prompt).toContain(
      `- Target: the Chart component (apps/site/src/lib/Chart.svelte, used at apps/site/${FILE}:3)`
    );
  });
});

describe("scopesFor", () => {
  const picked = { ...CARD_SITE, name: "PricingCard" };

  it("names the picked component by the file main resolved for its call site", () => {
    const { scopes, pickedIndex, unresolved } = scopesFor(nestedSelection(), picked, RESOLVED);
    expect(unresolved).toBe(false);
    expect(pickedIndex).toBe(1);
    expect(scopes[pickedIndex]).toEqual({
      kind: "component",
      label: "PricingCard",
      file: CARD,
      usedAt: CARD_SITE,
    });
  });

  it("keeps the pick selected but unsendable until its file is proven", () => {
    for (const definitions of [null, { [callSiteKey(CARD_SITE)]: null }]) {
      const result = scopesFor(nestedSelection(), picked, definitions);
      expect(result.unresolved).toBe(true);
      expect(result.scopes[result.pickedIndex]).toMatchObject({ label: "PricingCard", file: null });
    }
  });

  it("still offers a picked component whose call site isn't on the chain", () => {
    const outside = { file: ".svelte-kit/generated/root.svelte", line: 1, column: 0, name: "Page" };
    const { scopes, pickedIndex, unresolved } = scopesFor(nestedSelection(), outside, {
      ...RESOLVED,
      [callSiteKey(outside)]: FILE,
    });
    expect(pickedIndex).toBe(1);
    expect(unresolved).toBe(false);
    expect(scopes[1]).toMatchObject({ label: "Page", file: FILE });
  });

  it("points at the element when nothing was picked, even without a traced source", () => {
    const result = scopesFor(makeSelection({ node: { definition: null } }), null);
    expect(result.scopes[result.pickedIndex]?.kind).toBe("element");
  });
});
