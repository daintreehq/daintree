import { beforeAll, describe, expect, it } from "vitest";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import type {
  BuiltInPanelKind,
  PanelExitBehavior,
  PanelInstance,
  TerminalInstance,
} from "@shared/types/panel";
import type { BrowserHistory } from "@shared/types/browser";
import { getDeserializer } from "@/config/panelKindSerialisers";
import type { SavedTerminalData } from "@/utils/stateHydration/statePatcher";
import { initBuiltInPanelKinds } from "../registry";

// Field-coverage meta-test. Every persisted field listed below must be
// referenced by both the serializer and the deserializer, so a rename or
// removal on one side surfaces as a loud test failure rather than silent
// data loss on restore.
//
// The per-kind arrays are a ratchet, not exhaustive: newly added persisted
// fields must be appended here by hand. The `satisfies readonly (keyof …)[]`
// binding catches renames and key removals at TypeScript compile time.
//
// Asymmetries:
//  - terminal has no getDeserializer() entry — agent-running terminals restore
//    through buildArgsForRespawn / buildArgsForBackendTerminal using backend
//    PTY state. Serializer coverage only.
//  - dev-preview `cwd` and `exitBehavior` are injected by
//    buildArgsForNonPtyRecreation's base args, not the registry deserializer.
//    Excluded from the deserializer-side check for that kind.

type PtyData = Extract<PanelInstance, { kind: "terminal" }>;
type BrowserData = Extract<PanelInstance, { kind: "browser" }>;
type DevPreviewData = Extract<PanelInstance, { kind: "dev-preview" }>;

const PERSISTED_PTY_FIELDS = [
  "launchAgentId",
  "cwd",
  "command",
  "exitBehavior",
  "agentSessionId",
  "agentLaunchFlags",
  "agentModelId",
  "agentPresetId",
  "agentPresetColor",
  "originalPresetId",
  "isUsingFallback",
  "fallbackChainIndex",
  "agentState",
  "lastStateChange",
] as const satisfies readonly (keyof PtyData)[];

const PERSISTED_BROWSER_FIELDS = [
  "browserUrl",
  "browserHistory",
  "browserZoom",
  "browserConsoleOpen",
] as const satisfies readonly (keyof BrowserData)[];

const PERSISTED_DEV_PREVIEW_FIELDS = [
  "cwd",
  "devCommand",
  "browserUrl",
  "browserHistory",
  "browserZoom",
  "devPreviewConsoleOpen",
  "devPreviewScrollPosition",
  "exitBehavior",
] as const satisfies readonly (keyof DevPreviewData)[];

const BUILT_IN_KINDS = [
  "terminal",
  "browser",
  "dev-preview",
] as const satisfies readonly BuiltInPanelKind[];

// Compile-time exhaustiveness pin: if a new BuiltInPanelKind is added and not
// listed above, this assignment fails with a message naming the missing kind.
type _MissingBuiltInKinds = Exclude<BuiltInPanelKind, (typeof BUILT_IN_KINDS)[number]>;
const _builtInKindsExhaustive: [_MissingBuiltInKinds] extends [never]
  ? true
  : _MissingBuiltInKinds = true;
void _builtInKindsExhaustive;

const browserHistoryFixture: BrowserHistory = {
  past: ["https://prev.example"],
  present: "https://example.com",
  future: [],
};

function baseFields(
  kind: PanelInstance["kind"]
): Pick<TerminalInstance, "id" | "title" | "location" | "kind"> {
  return { id: `panel-${kind}`, title: "Panel", location: "grid", kind };
}

// Fully-populated fixtures — every persisted field set to a truthy, non-empty,
// non-null value so every conditional spread in the serializers emits its key.

const terminalFixture: TerminalInstance = {
  ...baseFields("terminal"),
  launchAgentId: "claude",
  titleMode: "default",
  cwd: "/home/project",
  command: "npm start",
  exitBehavior: "keep" satisfies PanelExitBehavior,
  agentSessionId: "session-abc",
  agentLaunchFlags: ["--resume"],
  agentModelId: "claude-3-5-sonnet",
  agentPresetId: "blue-provider",
  agentPresetColor: "#3366ff",
  originalPresetId: "primary-provider",
  isUsingFallback: true,
  fallbackChainIndex: 1,
  agentState: "idle",
  lastStateChange: 1_700_000_000_000,
};

const browserFixture: TerminalInstance = {
  ...baseFields("browser"),
  browserUrl: "https://example.com",
  browserHistory: browserHistoryFixture,
  browserZoom: 1.5,
  // `false` is deliberate — the browser serializer uses `!== undefined`, so
  // falsy-but-defined values must still emit the key.
  browserConsoleOpen: false,
};

const devPreviewFixture: TerminalInstance = {
  ...baseFields("dev-preview"),
  cwd: "/home/project",
  devCommand: "npm run dev",
  browserUrl: "http://localhost:3000",
  browserHistory: browserHistoryFixture,
  browserZoom: 1,
  devPreviewConsoleOpen: false,
  devPreviewScrollPosition: { url: "http://localhost:3000", scrollY: 250 },
  exitBehavior: "keep",
};

const savedBrowser: SavedTerminalData = {
  id: "panel-browser",
  kind: "browser",
  browserUrl: "https://example.com",
  browserHistory: browserHistoryFixture,
  browserZoom: 1.5,
  browserConsoleOpen: false,
};

const savedDevPreview: SavedTerminalData = {
  id: "panel-dev-preview",
  kind: "dev-preview",
  devCommand: "npm run dev",
  browserUrl: "http://localhost:3000",
  browserHistory: browserHistoryFixture,
  browserZoom: 1,
  devPreviewConsoleOpen: false,
  devPreviewScrollPosition: { url: "http://localhost:3000", scrollY: 250 },
  exitBehavior: "keep",
  createdAt: 1_700_000_000_000,
};

function assertCovers(
  label: string,
  output: Record<string, unknown>,
  expectedFields: readonly string[],
  renames: Record<string, string> = {},
  excluded: readonly string[] = []
): void {
  const keys = Object.keys(output);
  for (const field of expectedFields) {
    if (excluded.includes(field)) continue;
    const outputKey = renames[field] ?? field;
    expect(
      keys,
      `${label} missing persisted field "${field}"` +
        (outputKey === field ? "" : ` (output key "${outputKey}")`) +
        `; keys=${keys.join(",")}`
    ).toContain(outputKey);
    // Reject stub implementations that emit the key with an `undefined` value.
    // All fixtures below supply defined, non-undefined values for every field,
    // so a real serializer/deserializer must propagate them.
    expect(
      output[outputKey],
      `${label} persisted field "${field}" was present but undefined — stub implementation?`
    ).not.toBeUndefined();
  }
}

beforeAll(() => {
  initBuiltInPanelKinds();
});

describe("panel serializer field coverage", () => {
  it("every built-in kind registers a serializer", () => {
    for (const kind of BUILT_IN_KINDS) {
      const config = getPanelKindConfig(kind);
      expect(config?.serialize, `kind "${kind}" missing serialize`).toBeTypeOf("function");
    }
  });

  it("terminal serializer covers every persisted PTY field", () => {
    const output = getPanelKindConfig("terminal")!.serialize!(terminalFixture) as Record<
      string,
      unknown
    >;
    assertCovers("terminal serializer", output, PERSISTED_PTY_FIELDS);
  });

  it("browser serializer covers every persisted browser field", () => {
    const output = getPanelKindConfig("browser")!.serialize!(browserFixture) as Record<
      string,
      unknown
    >;
    assertCovers("browser serializer", output, PERSISTED_BROWSER_FIELDS);
  });

  it("dev-preview serializer covers every persisted dev-preview field (devCommand → command)", () => {
    const output = getPanelKindConfig("dev-preview")!.serialize!(devPreviewFixture) as Record<
      string,
      unknown
    >;
    assertCovers("dev-preview serializer", output, PERSISTED_DEV_PREVIEW_FIELDS, {
      devCommand: "command",
    });
  });
});

describe("panel deserializer field coverage", () => {
  it("browser deserializer covers every persisted browser field", () => {
    const deserializer = getDeserializer("browser");
    expect(deserializer, "browser deserializer must be registered").toBeDefined();
    const output = deserializer!(savedBrowser) as Record<string, unknown>;
    assertCovers("browser deserializer", output, PERSISTED_BROWSER_FIELDS);
  });

  it("dev-preview deserializer covers every persisted dev-preview field (cwd + exitBehavior via base args)", () => {
    const deserializer = getDeserializer("dev-preview");
    expect(deserializer, "dev-preview deserializer must be registered").toBeDefined();
    const output = deserializer!(savedDevPreview) as Record<string, unknown>;
    // `cwd` and `exitBehavior` are injected by buildArgsForNonPtyRecreation's
    // base args, not the dev-preview deserializer, so they are excluded here.
    assertCovers("dev-preview deserializer", output, PERSISTED_DEV_PREVIEW_FIELDS, {}, [
      "cwd",
      "exitBehavior",
    ]);
  });

  it("terminal has no deserializer registry entry", () => {
    // PTY panels (including agent-running terminals) restore through
    // buildArgsForRespawn / buildArgsForBackendTerminal using BackendTerminalData,
    // not the getDeserializer() registry. Pinning this asymmetry so an
    // accidental registry entry forces a deliberate decision about the new
    // restore path.
    expect(getDeserializer("terminal")).toBeUndefined();
  });
});
