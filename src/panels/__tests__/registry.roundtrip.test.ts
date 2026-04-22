import { beforeAll, describe, expect } from "vitest";
import { fc, test } from "@fast-check/vitest";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import type { PanelInstance, TerminalInstance } from "@shared/types/panel";
import { getDeserializer } from "@/config/panelKindSerialisers";
import type { SavedTerminalData } from "@/utils/stateHydration/statePatcher";
import { initBuiltInPanelKinds } from "../registry";

beforeAll(() => {
  initBuiltInPanelKinds();
});

type PtyData = Extract<PanelInstance, { kind: "terminal" | "agent" }>;
type BrowserData = Extract<PanelInstance, { kind: "browser" }>;
type DevPreviewData = Extract<PanelInstance, { kind: "dev-preview" }>;

// Persisted-field union per kind. The arbitrary spec is bound via `satisfies`
// below; that catches type drift on the listed fields (renames, type changes,
// removals) as a TS error at the spec declaration. Adding a *new* persisted
// field still requires extending the union here by hand — this guard is a
// ratchet on the fields already enumerated, not a full exhaustiveness check.
//
// `createdAt` is intentionally absent from the pty and dev-preview unions: the
// serializers handle it as a legacy `TerminalInstance` fallback, but it isn't
// declared on `PtyPanelData` or `DevPreviewPanelData`. The literal-value round
// trip for dev-preview's `createdAt` is still exercised in
// registry.serialization.test.ts.
type PersistedPtyFields =
  | "type"
  | "agentId"
  | "cwd"
  | "command"
  | "exitBehavior"
  | "agentSessionId"
  | "agentLaunchFlags"
  | "agentModelId"
  | "agentState"
  | "lastStateChange";

type PersistedBrowserFields =
  | "browserUrl"
  | "browserHistory"
  | "browserZoom"
  | "browserConsoleOpen";

type PersistedDevPreviewFields =
  | "cwd"
  | "devCommand"
  | "browserUrl"
  | "browserHistory"
  | "browserZoom"
  | "devPreviewConsoleOpen"
  | "exitBehavior";

const browserHistoryArb = fc.record({
  past: fc.array(fc.string()),
  present: fc.string(),
  future: fc.array(fc.string()),
});

const exitBehaviorArb = fc.constantFrom(
  "keep" as const,
  "trash" as const,
  "remove" as const,
  "restart" as const
);

const agentStateArb = fc.constantFrom(
  "idle" as const,
  "working" as const,
  "running" as const,
  "waiting" as const,
  "directing" as const,
  "completed" as const,
  "exited" as const
);

const terminalTypeArb = fc.constantFrom(
  "terminal" as const,
  "claude" as const,
  "gemini" as const,
  "codex" as const,
  "opencode" as const,
  "cursor" as const,
  "kiro" as const,
  "copilot" as const
);

const zoomArb = fc.double({ min: 0.25, max: 5.0, noNaN: true, noDefaultInfinity: true });

const ptyArbSpec = {
  type: terminalTypeArb,
  agentId: fc.option(fc.string(), { nil: undefined }),
  cwd: fc.string(),
  command: fc.option(fc.string(), { nil: undefined }),
  exitBehavior: fc.option(exitBehaviorArb, { nil: undefined }),
  agentSessionId: fc.option(fc.string(), { nil: undefined }),
  agentLaunchFlags: fc.option(fc.array(fc.string()), { nil: undefined }),
  agentModelId: fc.option(fc.string(), { nil: undefined }),
  agentState: fc.option(agentStateArb, { nil: undefined }),
  lastStateChange: fc.option(fc.integer({ min: 0 }), { nil: undefined }),
} satisfies { [K in PersistedPtyFields]-?: fc.Arbitrary<PtyData[K]> };

const browserArbSpec = {
  browserUrl: fc.option(fc.string(), { nil: undefined }),
  browserHistory: fc.option(browserHistoryArb, { nil: undefined }),
  browserZoom: fc.option(zoomArb, { nil: undefined }),
  browserConsoleOpen: fc.option(fc.boolean(), { nil: undefined }),
} satisfies { [K in PersistedBrowserFields]-?: fc.Arbitrary<BrowserData[K]> };

const devPreviewArbSpec = {
  cwd: fc.string(),
  devCommand: fc.option(fc.string(), { nil: undefined }),
  browserUrl: fc.option(fc.string(), { nil: undefined }),
  browserHistory: fc.option(browserHistoryArb, { nil: undefined }),
  browserZoom: fc.option(zoomArb, { nil: undefined }),
  devPreviewConsoleOpen: fc.option(fc.boolean(), { nil: undefined }),
  exitBehavior: fc.option(exitBehaviorArb, { nil: undefined }),
} satisfies { [K in PersistedDevPreviewFields]-?: fc.Arbitrary<DevPreviewData[K]> };

const ptyArb = fc.record(ptyArbSpec);
const browserArb = fc.record(browserArbSpec);
const devPreviewArb = fc.record(devPreviewArbSpec);

function basePanel(
  kind: PanelInstance["kind"]
): Pick<TerminalInstance, "id" | "title" | "location" | "kind"> {
  return { id: "panel-id", title: "Panel", location: "grid", kind };
}

describe("panel serializer round-trip (property tests)", () => {
  describe("terminal", () => {
    // Terminal/agent have no getDeserializer entry — their restore path runs
    // through buildArgsForRespawn / buildArgsForBackendTerminal which involves
    // agent session resume and model-selection logic outside this file's scope.
    // Property test the serializer's output shape and trimming/omission rules.
    test.prop([ptyArb])("serializer output matches input under trim & omit rules", (fields) => {
      const input: TerminalInstance = { ...basePanel("terminal"), ...fields };
      const result = getPanelKindConfig("terminal")!.serialize!(input);

      expect(result.type).toBe(fields.type);
      expect(result.agentId).toBe(fields.agentId);
      expect(result.cwd).toBe(fields.cwd);
      expect(result.command).toBe(fields.command?.trim() || undefined);

      if (fields.exitBehavior !== undefined) {
        expect(result.exitBehavior).toBe(fields.exitBehavior);
      } else {
        expect("exitBehavior" in result).toBe(false);
      }

      if (fields.lastStateChange !== undefined) {
        expect(result.lastStateChange).toBe(fields.lastStateChange);
      } else {
        expect("lastStateChange" in result).toBe(false);
      }

      if (fields.agentSessionId) {
        expect(result.agentSessionId).toBe(fields.agentSessionId);
      } else {
        expect("agentSessionId" in result).toBe(false);
      }

      if (fields.agentModelId) {
        expect(result.agentModelId).toBe(fields.agentModelId);
      } else {
        expect("agentModelId" in result).toBe(false);
      }

      if (fields.agentState) {
        expect(result.agentState).toBe(fields.agentState);
      } else {
        expect("agentState" in result).toBe(false);
      }

      if (fields.agentLaunchFlags?.length) {
        expect(result.agentLaunchFlags).toEqual(fields.agentLaunchFlags);
      } else {
        expect("agentLaunchFlags" in result).toBe(false);
      }
    });
  });

  describe("browser", () => {
    test.prop([browserArb])(
      "deserialize(serialize(x)) preserves all persisted fields",
      (fields) => {
        const input: TerminalInstance = { ...basePanel("browser"), ...fields };
        const saved = getPanelKindConfig("browser")!.serialize!(input) as SavedTerminalData;
        const restored = getDeserializer("browser")!(saved);

        expect(restored.browserUrl).toBe(fields.browserUrl);
        expect(restored.browserHistory).toEqual(fields.browserHistory);
        expect(restored.browserZoom).toBe(fields.browserZoom);
        expect(restored.browserConsoleOpen).toBe(fields.browserConsoleOpen);
      }
    );
  });

  describe("dev-preview", () => {
    test.prop([devPreviewArb])(
      "deserialize(serialize(x)) preserves fields through devCommand↔command rename",
      (fields) => {
        const input: TerminalInstance = {
          ...basePanel("dev-preview"),
          type: "terminal",
          ...fields,
        };
        const saved = getPanelKindConfig("dev-preview")!.serialize!(input) as SavedTerminalData;
        const restored = getDeserializer("dev-preview")!(saved);

        // Serializer writes t.devCommand?.trim() into snapshot.command; deserializer
        // prefers snapshot.devCommand, then falls back to snapshot.command. Whitespace
        // and empty strings normalise to undefined.
        expect(restored.devCommand).toBe(fields.devCommand?.trim() || undefined);

        expect(restored.browserUrl).toBe(fields.browserUrl);
        expect(restored.browserHistory).toEqual(fields.browserHistory);
        expect(restored.browserZoom).toBe(fields.browserZoom);
        expect(restored.devPreviewConsoleOpen).toBe(fields.devPreviewConsoleOpen);

        // exitBehavior is NOT returned by getDeserializer("dev-preview"); the real
        // restore path adds it via buildArgsForNonPtyRecreation's base args before
        // merging the deserializer result, so it is out of scope for this assertion.
      }
    );
  });
});
