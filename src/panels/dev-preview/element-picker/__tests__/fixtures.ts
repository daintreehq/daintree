import { createHash } from "node:crypto";
import type {
  ComponentRecord,
  ResolutionResult,
  SelectionObservation,
  SourceCandidate,
} from "@shared/elementPicker";
import type { PickedSelection } from "../selection.js";

/**
 * The core picker's view of a Svelte pricing page and a React dashboard, as
 * the page reports them and as the host answers: the same shapes the guest
 * extractors and the resolvers produce.
 */

export const sha = (text: string) =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

export const WORKSPACE = "ws-1";
export const FILE = "src/routes/pricing/+page.svelte";
export const CARD_FILE = "src/lib/PricingCard.svelte";
export const SOURCE = [
  "<script>",
  "  let plan = 'pro';",
  "</script>",
  "",
  '<article class="card">',
  '  <button class="px-6 py-3 rounded-lg" type="button">Start Pro</button>',
  "</article>",
  "",
].join("\n");
export const REVISION = sha(SOURCE);
export const CARD_REVISION = sha("<PricingCard />");

const SVELTE = { lineBase: 1, columnBase: 0, columnUnit: "utf16" } as const;

type Invocation = Extract<SourceCandidate, { kind: "component-invocation" }>;
const V8 = { lineBase: 1, columnBase: 1, columnUnit: "utf16" } as const;

export const STAMP: Extract<SourceCandidate, { kind: "template-location" }> = {
  kind: "template-location",
  candidateId: "svelte-loc",
  framework: "svelte",
  extraction: { kind: "runtime-field", field: "__svelte_meta.loc" },
  file: FILE,
  location: { ...SVELTE, line: 6, column: 2 },
};

/** `<PricingCard>` written at line 3 of the route page. */
export const CARD_CALL: Invocation = {
  kind: "component-invocation",
  candidateId: "svelte-call-0",
  framework: "svelte",
  extraction: { kind: "runtime-field", field: "__svelte_meta.parent" },
  file: FILE,
  location: { ...SVELTE, line: 3, column: 0 },
};

/** SvelteKit's generated shell, which invokes the route page. */
export const SHELL_CALL: Invocation = {
  kind: "component-invocation",
  candidateId: "svelte-call-1",
  framework: "svelte",
  extraction: { kind: "runtime-field", field: "__svelte_meta.parent" },
  file: ".svelte-kit/generated/root.svelte",
  location: { ...SVELTE, line: 1, column: 0 },
};

export function svelteRecord(
  componentId: string,
  name: string,
  call: SourceCandidate
): ComponentRecord {
  return {
    componentId,
    framework: "svelte",
    name: {
      value: name,
      extraction: { kind: "runtime-field", field: "__svelte_meta.parent.componentTag" },
    },
    environment: "client",
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates: [call],
  };
}

export const CARD = svelteRecord("c-card", "PricingCard", CARD_CALL);
export const SHELL = svelteRecord("c-shell", "Root", SHELL_CALL);

/** The button on the pricing page, one of three copies of the same markup. */
export function svelteObservation(
  overrides: Partial<SelectionObservation> = {}
): SelectionObservation {
  return {
    phase: "selection",
    elementId: "el-1",
    tagName: "BUTTON",
    label: 'button "Start Pro"',
    bounds: [{ x: 0, y: 0, width: 10, height: 10 }],
    detections: [],
    componentChain: { nearestId: CARD.componentId, components: [CARD, SHELL], truncated: false },
    sourceCandidates: [STAMP],
    capabilities: {
      names: { state: "available" },
      chain: { state: "available" },
      componentSelection: { state: "available" },
      file: { state: "available" },
      line: { state: "available" },
      exactRange: { state: "unknown" },
    },
    frameworkEvidence: [
      {
        kind: "svelte",
        ancestry: [
          { type: "each", file: FILE, line: 4, column: 0 },
          { type: "component", file: FILE, line: 3, column: 0, componentTag: "PricingCard" },
          {
            type: "component",
            file: ".svelte-kit/generated/root.svelte",
            line: 1,
            column: 0,
            componentTag: "Root",
          },
        ],
        sameLocCount: 3,
        locIndex: 2,
        unmapped: false,
      },
    ],
    context: {
      selector: "article.card > button",
      markup: '<button class="px-6 py-3 rounded-lg" type="button">Start Pro</button>',
      styles: [],
    },
    ...overrides,
  };
}

/** What the host makes of the Svelte button's claims: the element verified, the card's import followed. */
export function svelteResults(revision = REVISION): ResolutionResult[] {
  return [
    {
      state: "verified",
      candidateId: STAMP.candidateId,
      claim: "template-location",
      target: {
        file: { workspaceId: WORKSPACE, path: FILE },
        location: { ...SVELTE, line: 6, column: 2 },
      },
      fileRevision: revision,
    },
    {
      state: "verified",
      candidateId: CARD_CALL.candidateId,
      claim: "component-invocation",
      target: {
        file: { workspaceId: WORKSPACE, path: FILE },
        location: { ...SVELTE, line: 3, column: 0 },
      },
      fileRevision: revision,
      definition: {
        file: { workspaceId: WORKSPACE, path: CARD_FILE },
        fileRevision: CARD_REVISION,
        specifier: "$lib/PricingCard.svelte",
      },
    },
    {
      state: "unavailable",
      candidateId: SHELL_CALL.candidateId,
      claim: "component-invocation",
      reason: "unsupported",
    },
  ];
}

const DASHBOARD_JS = "http://localhost:5173/src/Dashboard.tsx";

/** A React button: a creation frame and a chain of two components with render edges. */
export function reactObservation(
  overrides: Partial<SelectionObservation> = {}
): SelectionObservation {
  const frame = (
    candidateId: string,
    kind: "element-creation" | "component-definition",
    line: number
  ): SourceCandidate => ({
    kind,
    candidateId,
    framework: "react",
    extraction: { kind: "generated-stack-frame", field: "_debugStack", frameIndex: 0 },
    file: DASHBOARD_JS,
    location: { ...V8, line, column: 7 },
  });
  return {
    phase: "selection",
    elementId: "el-r",
    tagName: "BUTTON",
    label: "button.save",
    bounds: [{ x: 0, y: 0, width: 10, height: 10 }],
    detections: [],
    componentChain: {
      nearestId: "r-save",
      components: [
        {
          componentId: "r-save",
          framework: "react",
          name: { value: "SaveButton", extraction: { kind: "runtime-field", field: "type.name" } },
          environment: "client",
          renderParentId: "r-toolbar",
          rootElementIds: ["el-r"],
          rootsComplete: true,
          sourceCandidates: [frame("r-save:def", "component-definition", 12)],
        },
        {
          componentId: "r-toolbar",
          framework: "react",
          name: { value: "Toolbar", extraction: { kind: "runtime-field", field: "type.name" } },
          environment: "client",
          renderParentId: null,
          rootElementIds: [],
          rootsComplete: false,
          sourceCandidates: [],
        },
      ],
      truncated: false,
    },
    sourceCandidates: [frame("r-create", "element-creation", 40)],
    capabilities: {
      names: { state: "available" },
      chain: { state: "available" },
      // SaveButton's roots are reported, so the page can select it.
      componentSelection: { state: "available" },
      file: { state: "unknown" },
      line: { state: "unknown" },
      exactRange: { state: "unknown" },
    },
    frameworkEvidence: [],
    ...overrides,
  };
}

/** The host maps the React frames through the dev server's maps, without reading the files. */
export function reactResults(): ResolutionResult[] {
  const sourceMap = { mapUrl: null, mapRevision: sha("map"), sourceCheck: "unchecked" as const };
  return [
    {
      state: "mapped",
      candidateId: "r-create",
      claim: "element-creation",
      target: {
        file: { workspaceId: WORKSPACE, path: "src/Dashboard.tsx" },
        location: { lineBase: 1, columnBase: 0, columnUnit: "utf16", line: 40, column: 6 },
      },
      fileRevision: null,
      sourceMap,
    },
    {
      state: "mapped",
      candidateId: "r-save:def",
      claim: "component-definition",
      target: {
        file: { workspaceId: WORKSPACE, path: "src/SaveButton.tsx" },
        location: { lineBase: 1, columnBase: 0, columnUnit: "utf16", line: 12, column: 0 },
      },
      fileRevision: null,
      sourceMap,
    },
  ];
}

/** A selection as the controller publishes it. */
export function picked(
  observations: SelectionObservation[],
  results: Record<string, ResolutionResult[]>,
  overrides: Partial<PickedSelection> = {}
): PickedSelection {
  return {
    selectionId: "sel-1",
    previewPanelId: "preview-1",
    sessionId: "session-1",
    documentEpoch: 0,
    workspaceId: WORKSPACE,
    appPath: ".",
    displayedUrl: "http://localhost:5173/pricing",
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    observations,
    results,
    scope: { kind: "element" },
    capturedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}
