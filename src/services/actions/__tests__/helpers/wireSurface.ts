import { z } from "zod";
import type { ActionId } from "@shared/types/actions";
import type { ActionRegistry, ActionCallbacks } from "../../actionTypes";
import {
  WORKBENCH_TIER_TOOLS,
  ACTION_TIER_ADDONS,
  SYSTEM_TIER_ADDONS,
} from "@shared/config/helpAssistantTierAllowlists";
import { MCP_EXTERNAL_TIER_TOOLS } from "@shared/config/mcpExternalTierAllowlist";
import { toWireSchema } from "@shared/utils/mcpWireSchema";

/**
 * Measurement of the bytes an MCP client is actually sent, built from the live
 * action registry rather than from a fixture.
 *
 * A fixture would be the wrong instrument here: the thing under budget is what
 * `tools/list` emits today, so a captured copy would drift silently and the
 * gates would go on passing against a surface that no longer exists.
 */

function noopCallbacks(): ActionCallbacks {
  const noop = () => {};
  return {
    onOpenSettings: noop,
    onOpenSettingsTab: noop,
    onToggleSidebar: noop,
    onToggleFocusMode: noop,
    onFocusRegionNext: noop,
    onFocusRegionPrev: noop,
    onOpenActionPalette: noop,
    onOpenQuickSwitcher: noop,
    onOpenWorktreePalette: noop,
    onOpenQuickCreatePalette: noop,
    onToggleWorktreeOverview: noop,
    onOpenWorktreeOverview: noop,
    onCloseWorktreeOverview: noop,
    onOpenPanelPalette: noop,
    onOpenResumeSessionsPalette: noop,
    onOpenProjectSwitcherPalette: noop,
    onConfirmCloseActiveProject: noop,
    onOpenShortcuts: noop,
    onLaunchAgent: async () => null,
    onInject: noop,
    onAddTerminal: async () => {},
    getDefaultCwd: () => "/",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
    getIsSettingsOpen: () => false,
    getGridNavigation: () => ({
      findNearest: () => null,
      findByIndex: () => null,
      findDockByIndex: () => null,
      getCurrentLocation: () => null,
    }),
  } as unknown as ActionCallbacks;
}

export async function createActionRegistry(): Promise<ActionRegistry> {
  // `actionDefinitions` reaches for `self` at module scope; the node test
  // environment has no window to supply it. Restored afterwards because vitest
  // reuses fork workers across files, and a leaked global is exactly the kind of
  // cross-file contamination that makes an unrelated suite fail by ordering.
  const globals = globalThis as unknown as { self?: unknown };
  const hadSelf = "self" in globals;
  const previousSelf = globals.self;
  globals.self = globalThis;
  try {
    const { createActionDefinitions } = await import("../../actionDefinitions");
    return createActionDefinitions(noopCallbacks(), new Map());
  } finally {
    if (hadSelf) globals.self = previousSelf;
    else delete globals.self;
  }
}

/** The exact conversion `ActionService.computeSchemas` performs. */
export function emitSchema(schema: z.ZodType, io: "input" | "output"): unknown {
  return z.toJSONSchema(schema, {
    io,
    unrepresentable: "any",
    reused: "inline",
    cycles: "ref",
    target: "draft-2020-12",
  });
}

export interface WirePropertyDescription {
  /** Dotted path to the schema node carrying the text, for a legible failure. */
  path: string;
  bytes: number;
  text: string;
}

export interface WireTool {
  id: string;
  external: boolean;
  description: string;
  descriptionBytes: number;
  /** The advertised input schema, already projected to the wire view. */
  inputSchema: unknown;
  paramsBytes: number;
  outputBytes: number;
  propertyDescriptions: WirePropertyDescription[];
}

/** Every `description` string in an emitted schema, with the path that owns it. */
function collectDescriptions(node: unknown, path: string, out: WirePropertyDescription[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectDescriptions(item, `${path}[${i}]`, out));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "description" && typeof value === "string") {
      out.push({ path: path || "<root>", bytes: Buffer.byteLength(value, "utf8"), text: value });
    } else {
      collectDescriptions(value, path === "" ? key : `${path}.${key}`, out);
    }
  }
}

const bytes = (value: unknown): number =>
  value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Every tool reachable at any MCP tier, measured as the wire view.
 *
 * The cohort is derived from the live allowlists rather than restated, so a tool
 * added to a tier is held to these budgets the moment it is exposed.
 */
export async function measureWireSurface(): Promise<WireTool[]> {
  const registry = await createActionRegistry();
  const external = new Set<string>(MCP_EXTERNAL_TIER_TOOLS);
  const cohort = new Set<string>([
    ...WORKBENCH_TIER_TOOLS,
    ...ACTION_TIER_ADDONS,
    ...SYSTEM_TIER_ADDONS,
    ...MCP_EXTERNAL_TIER_TOOLS,
  ]);

  const tools: WireTool[] = [];
  const missing: string[] = [];
  for (const id of [...cohort].sort()) {
    const def = registry.get(id as ActionId)?.();
    if (!def) {
      missing.push(id);
      continue;
    }

    let inputSchema: unknown = { type: "object", properties: {}, additionalProperties: false };
    if (def.argsSchema) {
      inputSchema = {
        ...(toWireSchema(emitSchema(def.argsSchema, "input")) as Record<string, unknown>),
        additionalProperties: false,
      };
    } else if (def.rawInputSchema) {
      inputSchema = toWireSchema(def.rawInputSchema);
    }

    // NOT projected, mirroring `buildToolOutputSchema`: an advertised output
    // schema is a contract the MCP SDK enforces client-side with AJV, so
    // production emits it verbatim. Projecting it here would undercount the
    // bytes `tools/list` really carries and quietly flatter every budget below.
    let outputSchema: unknown;
    if (def.mcpOutputSchema) {
      outputSchema = def.resultSchema
        ? emitSchema(def.resultSchema, "output")
        : def.rawOutputSchema;
    }

    const propertyDescriptions: WirePropertyDescription[] = [];
    collectDescriptions(inputSchema, "", propertyDescriptions);

    tools.push({
      id,
      external: external.has(id),
      description: def.description ?? "",
      descriptionBytes: Buffer.byteLength(def.description ?? "", "utf8"),
      inputSchema,
      paramsBytes: bytes(inputSchema),
      outputBytes: bytes(outputSchema),
      propertyDescriptions,
    });
  }

  // An allowlisted id with no registry entry is a broken tier, not a tool to
  // skip. Silently dropping it would shrink every aggregate below and let the
  // budgets pass by measuring less, which is the one failure a size gate must
  // never have.
  if (missing.length > 0) {
    throw new Error(
      `Tier allowlists name ${missing.length} action(s) absent from the registry: ${missing.join(", ")}`
    );
  }
  return tools;
}
