import {
  COORDINATE_CONVENTIONS,
  type Capabilities,
  type ComponentRecord,
  type HoverObservation,
  type SelectionObservation,
  type SourceCandidate,
} from "../index.js";

export const REVISION_A = `sha256:${"a".repeat(64)}`;
export const REVISION_B = `sha256:${"b".repeat(64)}`;

export function capabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  const unknown = { state: "unknown" } as const;
  return {
    names: unknown,
    chain: unknown,
    componentSelection: unknown,
    file: unknown,
    line: unknown,
    exactRange: unknown,
    ...overrides,
  };
}

const observationBase = {
  elementId: "el-1",
  tagName: "button",
  label: 'button "Save"',
  bounds: [{ x: 10, y: 20, width: 80, height: 24 }],
  detections: [],
  componentChain: { nearestId: null, components: [], truncated: false },
  sourceCandidates: [],
  capabilities: capabilities(),
  frameworkEvidence: [],
};

export function selection(overrides: Partial<SelectionObservation> = {}): SelectionObservation {
  return { phase: "selection", ...observationBase, ...overrides };
}

export function hover(overrides: Partial<HoverObservation> = {}): HoverObservation {
  return { phase: "hover", ...observationBase, ...overrides };
}

export function component(id: string, overrides: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    componentId: id,
    framework: "react",
    name: { value: id, extraction: { kind: "runtime-field", field: "type.name" } },
    environment: "client",
    rootElementIds: [],
    rootsComplete: true,
    sourceCandidates: [],
    ...overrides,
  };
}

/** A React 19 creation site: a `_debugStack` frame in the module the dev server served. */
export function creationFrame(candidateId = "c-1"): SourceCandidate {
  return {
    kind: "element-creation",
    candidateId,
    framework: "react",
    extraction: { kind: "generated-stack-frame", field: "_debugStack", frameIndex: 1 },
    file: "http://localhost:5173/src/Card.tsx?t=1700000000000",
    location: { ...COORDINATE_CONVENTIONS.v8StackFrame, columnUnit: "utf16", line: 42, column: 7 },
  };
}
