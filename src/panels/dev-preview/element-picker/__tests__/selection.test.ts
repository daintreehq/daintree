import { describe, expect, it } from "vitest";
import type { ProjectContextOutcome, ResolutionResult } from "@shared/elementPicker";
import { buildAgentTaskPrompt } from "../agentPrompt.js";
import {
  citedRevisions,
  componentsOf,
  elementPlace,
  heldPaths,
  isTraced,
  isUnresolvedScope,
  matchScope,
  promptInputFor,
  scopesFor,
  type PickedSelection,
} from "../selection.js";
import { trailFor } from "../SelectionTrail.js";
import {
  CARD,
  CARD_CALL,
  CARD_FILE,
  CARD_REVISION,
  FILE,
  REVISION,
  WORKSPACE,
  picked,
  reactObservation,
  reactResults,
  svelteObservation,
  svelteResults,
} from "./fixtures.js";

function svelte(overrides: Partial<PickedSelection> = {}): PickedSelection {
  return picked([svelteObservation()], { "el-1": svelteResults() }, overrides);
}

function react(): PickedSelection {
  return picked([reactObservation()], { "el-r": reactResults() });
}

function promptFor(
  selection: PickedSelection,
  scopeIndex = 0,
  project: ProjectContextOutcome | null = null
): string {
  return buildAgentTaskPrompt(
    promptInputFor({
      instruction: "Make it pop",
      selection,
      scope: scopesFor(selection).scopes[scopeIndex],
      worktreePath: "/repo",
      project,
      picture: { status: "omitted", reason: "test" },
    })
  );
}

describe("where a selection is written", () => {
  it("places a Svelte element where the host checked it, by 1-based line", () => {
    expect(elementPlace(svelte())).toEqual({ path: FILE, line: 6 });
  });

  it("places a React element where its creation frame mapped to", () => {
    expect(elementPlace(react())).toEqual({ path: "src/Dashboard.tsx", line: 40 });
  });

  it("never shows the page's own report as a place the host holds", () => {
    expect(elementPlace(picked([svelteObservation()], {}))).toBeNull();
  });

  it("calls a page with no source claims and no components untraced", () => {
    const bare = picked(
      [
        svelteObservation({
          sourceCandidates: [],
          componentChain: { nearestId: null, components: [], truncated: false },
        }),
      ],
      {},
      { workspaceId: null, appPath: null }
    );
    expect(isTraced(bare)).toBe(false);
    expect(scopesFor(bare).scopes).toEqual([{ kind: "element", label: 'button "Start Pro"' }]);
  });
});

describe("the component chain", () => {
  it("keeps a Svelte chain in the order the page listed it, leaving generated callers off", () => {
    expect(componentsOf(svelte()).map((component) => component.name)).toEqual(["PricingCard"]);
  });

  it("walks React render edges innermost first, whatever order the records came in", () => {
    const observation = reactObservation();
    const reversed = reactObservation({
      componentChain: {
        ...observation.componentChain,
        components: [...observation.componentChain.components].reverse(),
      },
    });
    const selection = picked([reversed], { "el-r": reactResults() });
    expect(componentsOf(selection).map((component) => component.name)).toEqual([
      "SaveButton",
      "Toolbar",
    ]);
  });

  it("names where a Svelte component is written by the import its call site follows", () => {
    const [card] = componentsOf(svelte());
    expect(card).toMatchObject({
      definedIn: { path: CARD_FILE, line: null },
      definedByImport: true,
      usedAt: { file: FILE, line: 3, column: 0 },
    });
  });

  it("names where a React component is written by its own mapped claim", () => {
    const [save, toolbar] = componentsOf(react());
    expect(save?.definedIn).toEqual({ path: "src/SaveButton.tsx", line: 12 });
    expect(save?.definedByImport).toBe(false);
    expect(toolbar?.definedIn).toBeNull();
  });

  it("runs the trail outermost first and ends at the element", () => {
    const trail = trailFor(react());
    expect(trail.above.map((crumb) => crumb.label)).toEqual(["Toolbar", "SaveButton"]);
    expect(trail.current.label).toBe("button.save");
  });
});

describe("request scopes", () => {
  it("offers the element, each component around it, and the file at the top", () => {
    const { scopes, pickedIndex } = scopesFor(svelte());
    expect(pickedIndex).toBe(0);
    expect(scopes).toEqual([
      { kind: "element", label: 'button "Start Pro"' },
      {
        kind: "component",
        label: "PricingCard",
        componentId: CARD.componentId,
        file: CARD_FILE,
        usedAt: { file: FILE, line: 3, column: 0 },
      },
      { kind: "file", label: "+page.svelte", file: FILE },
    ]);
  });

  it("places a picked component by its id, and matches it again in a later document by what it is", () => {
    const first = svelte({ scope: { kind: "component", componentId: CARD.componentId } });
    const { scopes, pickedIndex } = scopesFor(first);
    expect(scopes[pickedIndex]).toMatchObject({ kind: "component", label: "PricingCard" });

    // The page mints component ids per document; after a reload the same
    // invocation carries another.
    const card = { ...CARD, componentId: "c-card-2" };
    const later = picked(
      [
        svelteObservation({
          componentChain: { nearestId: card.componentId, components: [card], truncated: false },
        }),
      ],
      { "el-1": svelteResults() }
    );
    const index = matchScope(scopes[pickedIndex], scopesFor(later).scopes);
    expect(scopesFor(later).scopes[index]).toMatchObject({ componentId: "c-card-2" });
  });

  it("keeps a component whose file wasn't proven selectable but unsendable", () => {
    const results = svelteResults().filter(
      (result) => result.candidateId !== CARD_CALL.candidateId
    );
    const selection = picked([svelteObservation()], { "el-1": results });
    const component = scopesFor(selection).scopes[1];
    expect(component).toMatchObject({ kind: "component", file: null });
    expect(isUnresolvedScope(component)).toBe(true);
  });
});

describe("what a request cites", () => {
  it("holds every file the host read to the revision it read", () => {
    expect(citedRevisions(svelte())).toEqual({ [FILE]: REVISION, [CARD_FILE]: CARD_REVISION });
  });

  it("cites no revision for a claim the host mapped without reading the file", () => {
    expect(citedRevisions(react())).toEqual({});
  });

  it("watches every file a claim is held in, revisioned or not", () => {
    expect([...heldPaths(react())].sort()).toEqual(["src/Dashboard.tsx", "src/SaveButton.tsx"]);
    expect([...heldPaths(svelte())].sort()).toEqual([CARD_FILE, FILE].sort());
  });

  it("proves neither of two reads of one file that disagree", () => {
    const results: ResolutionResult[] = [
      ...svelteResults(),
      {
        state: "verified",
        candidateId: "other",
        claim: "template-location",
        target: { file: { workspaceId: WORKSPACE, path: FILE }, location: null },
        fileRevision: `sha256:${"f".repeat(64)}`,
      },
    ];
    expect(citedRevisions(picked([svelteObservation()], { "el-1": results }))[FILE]).toBeNull();
  });
});

describe("the request built from a selection", () => {
  it("cites a React element's file and line, and its component chain", () => {
    const prompt = promptFor(react());
    expect(prompt).toContain("created at src/Dashboard.tsx:40:7");
    expect(prompt).toContain('"SaveButton"');
    expect(prompt).toContain('"Toolbar"');
  });

  it("lists a Svelte chain the page reported without edges, in its own order", () => {
    const prompt = promptFor(svelte());
    expect(prompt.indexOf('"PricingCard"')).toBeGreaterThan(-1);
    expect(prompt.indexOf('"PricingCard"')).toBeLessThan(prompt.indexOf('"Root"'));
  });

  it("names the file its call site imports a picked component from", () => {
    const prompt = promptFor(svelte(), 1);
    expect(prompt).toContain("- Target: the");
    expect(prompt).toContain(`Written in ${CARD_FILE} (the file its call site imports it from)`);
  });

  it("aims a request about the outermost file at that file", () => {
    const prompt = promptFor(svelte(), 2);
    expect(prompt).toContain(`- Target: the file ${FILE}`);
    expect(prompt).toContain("Keep the change inside that file");
  });

  it("carries the route and toolchain the host read, and where the app sits", () => {
    const project: ProjectContextOutcome = {
      status: "described",
      context: {
        adapter: "sveltekit",
        appPath: "apps/site",
        route: {
          routeId: "/pricing",
          files: [
            {
              role: "layout",
              file: { workspaceId: WORKSPACE, path: "apps/site/src/routes/+layout.svelte" },
            },
            {
              role: "page",
              file: { workspaceId: WORKSPACE, path: "apps/site/src/routes/pricing/+page.svelte" },
            },
          ],
        },
        routes: {
          directory: "apps/site/src/routes",
          source: "default",
          basePath: "",
          complete: true,
        },
        toolchain: {
          versions: { svelte: "5.1.0", kit: "2.8.0", tailwind: null, vite: "8.0.0" },
          verdict: "tested",
          reasons: [],
          missingInstall: [],
        },
        diagnostics: [],
      },
    };
    const prompt = promptFor(svelte({ appPath: "apps/site" }), 0, project);
    expect(prompt).toContain("- App: apps/site (SvelteKit 2.8.0, Svelte 5.1.0, no Tailwind)");
    expect(prompt).toContain("- Files the page reports are relative to the app, not the worktree");
    expect(prompt).toContain("(route /pricing)");
    expect(prompt).toContain("  - page: apps/site/src/routes/pricing/+page.svelte");
  });

  it("says a page selection traced nothing", () => {
    const bare = picked(
      [
        svelteObservation({
          sourceCandidates: [],
          componentChain: { nearestId: null, components: [], truncated: false },
          frameworkEvidence: [],
        }),
      ],
      {},
      { workspaceId: null, appPath: null }
    );
    const prompt = promptFor(bare);
    expect(prompt).toContain("no source file was traced");
    expect(prompt).toContain('  - Selector: "article.card > button"');
  });
});
