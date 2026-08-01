import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentContributionSchema,
  AgentDetectionConfigSchema,
  CommandContributionSchema,
  ContextMenuContributionSchema,
  CredentialFieldSchema,
  FileDecorationContributionSchema,
  ForgeProviderContributionSchema,
  getPluginManifestSchema,
  KeybindingContributionSchema,
  McpServerContributionSchema,
  MenuItemContributionSchema,
  PanelContributionObjectSchema,
  ProcessToolContributionSchema,
  SettingDefinitionObjectSchema,
  SkillContributionSchema,
  ToolbarButtonContributionSchema,
  ViewContributionSchema,
} from "../plugin.js";

/**
 * Contract test for #10888: every field the plugin-manifest schema accepts must
 * have a real runtime (or first-party tooling) consumer. The manifest schema is
 * strict and will be frozen at 1.0 — a field an author can set that nothing
 * reads is a silent lie in the public contract. This test walks each
 * `contributes.*` contribution schema (and the high-fanout nested schemas) and
 * asserts every accepted field is present in a hand-authored field→consumer
 * map. A new schema field fails this test until it is wired to a consumer (or
 * cut), which keeps the schema and the runtime from silently drifting apart.
 *
 * The map is the assertion, not the source of truth: it records WHERE and HOW
 * each field is consumed. `mode` distinguishes a value read and applied
 * verbatim from one that only feeds a host-derived value (`danger` → the
 * host-authoritative `effectiveDanger`, #8331), one validated only as a
 * cross-reference against another contribution, and one deliberately validated
 * for shape without runtime authority (documented in the schema). The runtime
 * sweep below is the regression guard; the `satisfies`/assignment check adds a
 * compile-time break when a field is added to a schema without a map entry.
 *
 * Scope note: this is a curated map, not a static usage analysis — it proves a
 * consumer file EXISTS and is documented for every accepted field, and that the
 * schema's field set can't drift from the map. It does not statically prove the
 * cited symbol still reads the field; that stays a human-reviewed claim.
 */

type ConsumerMode = "verbatim" | "derived-input" | "cross-reference" | "intentional-metadata";

const ALL_MODES: readonly ConsumerMode[] = [
  "verbatim",
  "derived-input",
  "cross-reference",
  "intentional-metadata",
];

interface ConsumerRef {
  /** Repo-relative path (POSIX) to a file that consumes the field. */
  file: string;
  /** The symbol / function / component that reads the field, for the reader. */
  symbol: string;
}

interface ConsumerDescriptor {
  mode: ConsumerMode;
  consumers: readonly ConsumerRef[];
  /** Why/how the field is consumed — kept short but always present. */
  note: string;
}

const PLUGIN_SERVICE = "electron/services/PluginService.ts";
const TERMINAL_ACTIVITY_PATTERNS = "electron/services/pty/terminalActivityPatterns.ts";
const PLUGIN_SETTINGS_FORM = "src/components/Settings/PluginSettingsForm.tsx";
const CODE_FORGE_TAB = "src/components/Settings/CodeForgeSettingsTab.tsx";
const FORGE_REGISTRY = "electron/services/forgeProviderRegistry.ts";
const AGENT_REGISTRY = "shared/config/pluginAgentRegistry.ts";
const MCP_SUPERVISOR = "electron/services/PluginMcpSupervisor.ts";
const PLUGIN_SCHEMA = "electron/schemas/plugin.ts";
const SKILL_REGISTRY = "electron/services/plugin/PluginSkillRegistry.ts";
const PROCESS_TOOL_REGISTRY = "shared/config/pluginProcessToolRegistry.ts";
const PROCESS_DETECTOR_REGISTRIES = "electron/services/ProcessDetector/registries.ts";

/**
 * The schemas swept for field coverage. The first block matches the fourteen
 * `contributes.*` array kinds one-to-one; the second block covers the
 * high-fanout nested object schemas (a new detection tuning field or credential
 * field would otherwise be able to drift silently under a top-level kind).
 */
const SWEPT_SCHEMAS = {
  panels: PanelContributionObjectSchema,
  toolbarButtons: ToolbarButtonContributionSchema,
  menuItems: MenuItemContributionSchema,
  keybindings: KeybindingContributionSchema,
  contextMenus: ContextMenuContributionSchema,
  commands: CommandContributionSchema,
  views: ViewContributionSchema,
  mcpServers: McpServerContributionSchema,
  skills: SkillContributionSchema,
  forgeProviders: ForgeProviderContributionSchema,
  fileDecorationProviders: FileDecorationContributionSchema,
  agents: AgentContributionSchema,
  processTools: ProcessToolContributionSchema,
  settings: SettingDefinitionObjectSchema,
  "agents.detection": AgentDetectionConfigSchema,
  "forgeProviders.credentialFields": CredentialFieldSchema,
  "forgeProviders.slots": ForgeProviderContributionSchema.shape.slots,
} as const;

type SweptGroup = keyof typeof SWEPT_SCHEMAS;

/**
 * The fourteen keys that must line up one-to-one with `contributes.*`. Kept
 * separate from the nested-group keys so the "no unknown contribution kind"
 * guard can compare against exactly the parsed `contributes` shape.
 */
const TOP_LEVEL_GROUPS = [
  "panels",
  "toolbarButtons",
  "menuItems",
  "keybindings",
  "contextMenus",
  "commands",
  "views",
  "mcpServers",
  "skills",
  "forgeProviders",
  "fileDecorationProviders",
  "agents",
  "processTools",
  "settings",
] as const;

/** Reduce a swept schema entry to its ZodObject and read the field keys. */
function shapeKeys(schema: z.ZodType): string[] {
  const object =
    schema instanceof z.ZodObject
      ? schema
      : (schema as z.ZodOptional<z.ZodObject<z.ZodRawShape>>).unwrap();
  if (!(object instanceof z.ZodObject)) {
    throw new Error("Expected a ZodObject (directly or under an optional wrapper)");
  }
  return Object.keys(object.shape).sort();
}

/**
 * Compile-time coverage: `satisfies` this type checks the map literal in BOTH
 * directions per group — a NEW schema field breaks the build here (map missing
 * the key) and a STALE map entry for a removed field is flagged as excess. This
 * is the fast signal; the runtime sweep below is the backstop that also guards
 * against `z.infer` edge cases and anyone weakening these types.
 */
type ForgeSlots = NonNullable<z.infer<typeof ForgeProviderContributionSchema>["slots"]>;
type FieldConsumerCoverage = {
  panels: Record<keyof z.infer<typeof PanelContributionObjectSchema>, ConsumerDescriptor>;
  toolbarButtons: Record<keyof z.infer<typeof ToolbarButtonContributionSchema>, ConsumerDescriptor>;
  menuItems: Record<keyof z.infer<typeof MenuItemContributionSchema>, ConsumerDescriptor>;
  keybindings: Record<keyof z.infer<typeof KeybindingContributionSchema>, ConsumerDescriptor>;
  contextMenus: Record<keyof z.infer<typeof ContextMenuContributionSchema>, ConsumerDescriptor>;
  commands: Record<keyof z.infer<typeof CommandContributionSchema>, ConsumerDescriptor>;
  views: Record<keyof z.infer<typeof ViewContributionSchema>, ConsumerDescriptor>;
  mcpServers: Record<keyof z.infer<typeof McpServerContributionSchema>, ConsumerDescriptor>;
  skills: Record<keyof z.infer<typeof SkillContributionSchema>, ConsumerDescriptor>;
  forgeProviders: Record<keyof z.infer<typeof ForgeProviderContributionSchema>, ConsumerDescriptor>;
  fileDecorationProviders: Record<
    keyof z.infer<typeof FileDecorationContributionSchema>,
    ConsumerDescriptor
  >;
  agents: Record<keyof z.infer<typeof AgentContributionSchema>, ConsumerDescriptor>;
  processTools: Record<keyof z.infer<typeof ProcessToolContributionSchema>, ConsumerDescriptor>;
  settings: Record<keyof z.infer<typeof SettingDefinitionObjectSchema>, ConsumerDescriptor>;
  "agents.detection": Record<keyof z.infer<typeof AgentDetectionConfigSchema>, ConsumerDescriptor>;
  "forgeProviders.credentialFields": Record<
    keyof z.infer<typeof CredentialFieldSchema>,
    ConsumerDescriptor
  >;
  "forgeProviders.slots": Record<keyof ForgeSlots, ConsumerDescriptor>;
};

const MANIFEST_CONTRIBUTION_FIELD_CONSUMERS = {
  panels: {
    id: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "loadPlugin (panelId `${name}.${id}`)" }],
      note: "Namespaced into the registered panel-kind id.",
    },
    name: {
      mode: "verbatim",
      consumers: [{ file: "shared/config/panelKindRegistry.ts", symbol: "registerPanelKind" }],
      note: "Registered as the panel kind's display name.",
    },
    iconId: {
      mode: "verbatim",
      consumers: [{ file: "shared/config/panelKindRegistry.ts", symbol: "registerPanelKind" }],
      note: "Registered as the panel kind icon.",
    },
    color: {
      mode: "verbatim",
      consumers: [{ file: "shared/config/panelKindRegistry.ts", symbol: "registerPanelKind" }],
      note: "Registered as the panel kind accent color.",
    },
    hasPty: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "loadPlugin (panels loop)" }],
      note: "Selects PTY vs view rendering and gates the view componentPath attach.",
    },
    canRestart: {
      mode: "verbatim",
      consumers: [{ file: "shared/config/panelKindRegistry.ts", symbol: "registerPanelKind" }],
      note: "Registered as the panel kind restart policy.",
    },
    canConvert: {
      mode: "verbatim",
      consumers: [{ file: "shared/config/panelKindRegistry.ts", symbol: "registerPanelKind" }],
      note: "Registered as the panel kind convert policy.",
    },
    showInPalette: {
      mode: "verbatim",
      consumers: [{ file: "shared/config/panelKindRegistry.ts", symbol: "registerPanelKind" }],
      note: "Registered as the panel kind palette visibility.",
    },
    dockable: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "loadPlugin (panels loop) → registerPanelKind" }],
      note: "Registered as the panel kind dock eligibility; undefined defaults to dockable, false opts out (panelKindIsDockable).",
    },
  },
  toolbarButtons: {
    id: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "loadPlugin → registerToolbarButton" }],
      note: "Namespaced into the registered toolbar button id.",
    },
    label: {
      mode: "verbatim",
      consumers: [
        { file: "shared/config/toolbarButtonRegistry.ts", symbol: "registerToolbarButton" },
      ],
      note: "Registered as the toolbar button label.",
    },
    iconId: {
      mode: "verbatim",
      consumers: [
        { file: "shared/config/toolbarButtonRegistry.ts", symbol: "registerToolbarButton" },
      ],
      note: "Registered as the toolbar button icon.",
    },
    actionId: {
      mode: "verbatim",
      consumers: [
        { file: "shared/config/toolbarButtonRegistry.ts", symbol: "registerToolbarButton" },
      ],
      note: "Registered as the action the button dispatches.",
    },
    priority: {
      mode: "verbatim",
      consumers: [
        { file: PLUGIN_SERVICE, symbol: "loadPlugin (priority ?? 3)" },
        {
          file: "src/components/Layout/PluginTrayButton.tsx",
          symbol: "groupPluginToolbarButtons",
        },
      ],
      note: "Registered as the toolbar button ordering priority (defaulted to 3), consumed by the plugin tray's within-group sort (#11304).",
    },
  },
  menuItems: {
    label: {
      mode: "verbatim",
      consumers: [
        { file: "electron/services/pluginMenuRegistry.ts", symbol: "registerPluginMenuItem" },
      ],
      note: "Registered into the plugin menu registry read by the renderer menus.",
    },
    actionId: {
      mode: "verbatim",
      consumers: [
        { file: "electron/services/pluginMenuRegistry.ts", symbol: "registerPluginMenuItem" },
      ],
      note: "Registered as the action the menu item dispatches.",
    },
    location: {
      mode: "verbatim",
      consumers: [
        { file: "electron/services/pluginMenuRegistry.ts", symbol: "registerPluginMenuItem" },
      ],
      note: "Registered as the menu surface the item is placed into.",
    },
    accelerator: {
      mode: "verbatim",
      consumers: [
        { file: "electron/services/pluginMenuRegistry.ts", symbol: "registerPluginMenuItem" },
      ],
      note: "Registered as the menu item accelerator.",
    },
    when: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "loadPlugin → trackPluginExpression" }],
      note: "Tracked and evaluated as the item's visibility expression.",
    },
  },
  keybindings: {
    actionId: {
      mode: "verbatim",
      consumers: [
        {
          file: "electron/services/pluginKeybindingRegistry.ts",
          symbol: "registerPluginKeybinding",
        },
      ],
      note: "Registered as the action the keybinding dispatches.",
    },
    combo: {
      mode: "verbatim",
      consumers: [{ file: "src/services/keybindingUtils.ts", symbol: "parseCombo" }],
      note: "Parsed and matched against pressed key combos.",
    },
    scope: {
      mode: "verbatim",
      consumers: [{ file: "src/services/KeybindingService.ts", symbol: "KeybindingService" }],
      note: "Gates the binding to the active key scope (defaulted to global in the hook).",
    },
    description: {
      mode: "verbatim",
      consumers: [
        {
          file: "electron/services/pluginKeybindingRegistry.ts",
          symbol: "registerPluginKeybinding",
        },
      ],
      note: "Registered as the keybinding description shown in the renderer.",
    },
    when: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "loadPlugin → trackPluginExpression" }],
      note: "Tracked and evaluated as the binding's enablement expression.",
    },
  },
  contextMenus: {
    actionId: {
      mode: "verbatim",
      consumers: [
        {
          file: "electron/services/pluginContextMenuRegistry.ts",
          symbol: "registerPluginContextMenuItem",
        },
      ],
      note: "Registered as the action the context-menu item dispatches.",
    },
    location: {
      mode: "verbatim",
      consumers: [
        {
          file: "electron/services/pluginContextMenuRegistry.ts",
          symbol: "registerPluginContextMenuItem",
        },
      ],
      note: "Registered as the context-menu surface the item is placed into.",
    },
    label: {
      mode: "verbatim",
      consumers: [
        {
          file: "electron/services/pluginContextMenuRegistry.ts",
          symbol: "registerPluginContextMenuItem",
        },
      ],
      note: "Registered as the context-menu item label.",
    },
    when: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "loadPlugin → trackPluginExpression" }],
      note: "Tracked and evaluated as the item's visibility expression.",
    },
  },
  commands: {
    id: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "validateAndBuildActionDescriptor" }],
      note: "Namespaced into the registered action descriptor id.",
    },
    title: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "validateAndBuildActionDescriptor" }],
      note: "Copied into the action descriptor title.",
    },
    description: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "validateAndBuildActionDescriptor" }],
      note: "Copied into the action descriptor description.",
    },
    category: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "validateAndBuildActionDescriptor" }],
      note: "Copied into the action descriptor category.",
    },
    kind: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "validateAndBuildActionDescriptor" }],
      note: "Copied into the action descriptor kind (command vs query).",
    },
    danger: {
      mode: "derived-input",
      consumers: [
        { file: PLUGIN_SERVICE, symbol: "validateAndBuildActionDescriptor (effectiveDanger)" },
      ],
      note: "Advisory input to the host-authoritative effectiveDanger; raised, never trusted verbatim (#8331).",
    },
    keywords: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "validateAndBuildActionDescriptor" }],
      note: "Copied into the action descriptor keywords for palette search.",
    },
    inputSchema: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "validateAndBuildActionDescriptor" }],
      note: "Copied into the action descriptor inputSchema for arg validation.",
    },
    requires: {
      mode: "derived-input",
      consumers: [
        { file: PLUGIN_SERVICE, symbol: "validateAndBuildActionDescriptor (effectiveDanger)" },
      ],
      note: "Per-action capability intent (#11299): validated as a subset of manifest.capabilities, then narrows which capabilities effectiveDanger consults. Grants no access — never a capability check input.",
    },
  },
  views: {
    id: {
      mode: "cross-reference",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "loadPlugin (view → panel id match)" }],
      note: "Matched against a contributes.panels entry id to attach the view.",
    },
    componentPath: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "loadPlugin → buildPluginViewUrl" }],
      note: "Resolved to a plugin:// URL and attached to the panel kind.",
    },
    location: {
      mode: "cross-reference",
      consumers: [{ file: PLUGIN_SCHEMA, symbol: "ViewContributionSchema (literal 'panel')" }],
      note: "Literal gate tying the view to the panel host; a sidebar host is rejected at parse.",
    },
    iconId: {
      mode: "verbatim",
      consumers: [
        { file: "packages/daintree-plugin/src/commands/validate.ts", symbol: "validateManifest" },
      ],
      note: "Advisory: the SDK validate command flags an unrenderable view icon id.",
    },
  },
  mcpServers: {
    id: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "findMcpServerContribution" }],
      note: "Keys the supervised server state and IPC lookups.",
    },
    name: {
      mode: "verbatim",
      consumers: [{ file: MCP_SUPERVISOR, symbol: "PluginMcpSupervisor (handshake/display)" }],
      note: "Used in the server's display name and handshake diagnostics.",
    },
    command: {
      mode: "verbatim",
      consumers: [{ file: MCP_SUPERVISOR, symbol: "resolveContribution → spawn" }],
      note: "Substituted for ${settings:*} and spawned as the MCP subprocess command.",
    },
    args: {
      mode: "verbatim",
      consumers: [{ file: MCP_SUPERVISOR, symbol: "resolveContribution → spawn" }],
      note: "Substituted for ${settings:*} and passed as the subprocess argv.",
    },
    env: {
      mode: "verbatim",
      consumers: [{ file: MCP_SUPERVISOR, symbol: "resolveContribution → spawn" }],
      note: "Substituted for ${settings:*} and folded into the subprocess env.",
    },
  },
  skills: {
    id: {
      mode: "verbatim",
      consumers: [
        { file: SKILL_REGISTRY, symbol: "registerPluginSkills (qualifiedId `${pluginId}.${id}`)" },
      ],
      note: "Namespaced into the registered skill's qualified id.",
    },
    name: {
      mode: "verbatim",
      consumers: [{ file: SKILL_REGISTRY, symbol: "registerPluginSkills → indexSkill" }],
      note: "Copied into the registered skill and returned by skills.search / skills.load.",
    },
    path: {
      mode: "verbatim",
      consumers: [
        { file: SKILL_REGISTRY, symbol: "registerPluginSkills (resolveContainedPath → readFile)" },
      ],
      note: "Resolved against the plugin dir, realpath-contained, and read as the skill markdown.",
    },
    triggers: {
      mode: "verbatim",
      consumers: [{ file: SKILL_REGISTRY, symbol: "searchPluginSkills (trigger tokens)" }],
      note: "Tokenized into the skills.search keyword haystack.",
    },
  },
  forgeProviders: {
    id: {
      mode: "verbatim",
      consumers: [{ file: FORGE_REGISTRY, symbol: "registerForgeProviders" }],
      note: "Keys the frozen forge-provider descriptor and impl binding.",
    },
    name: {
      mode: "verbatim",
      consumers: [
        {
          file: "src/components/Settings/ForgeIntegrationsTab.tsx",
          symbol: "ForgeIntegrationsTab",
        },
      ],
      note: "Displayed as the provider name in settings.",
    },
    matches: {
      mode: "verbatim",
      consumers: [{ file: FORGE_REGISTRY, symbol: "hostnameMatchesAny" }],
      note: "Matched against a repo host to route to the provider.",
    },
    kind: {
      mode: "verbatim",
      consumers: [{ file: CODE_FORGE_TAB, symbol: "CodeForgeSettingsTab (kind === 'local')" }],
      note: "Switches local vs network provider presentation.",
    },
    capabilities: {
      mode: "verbatim",
      consumers: [{ file: CODE_FORGE_TAB, symbol: "ProviderSettingsBody (capabilities list)" }],
      note: "Rendered as the provider's capability list in settings; informational only — behavior gates on the runtime ForgeProviderImpl, never on these strings (schema doc).",
    },
    credentialFields: {
      mode: "verbatim",
      consumers: [
        { file: "electron/services/forge/forgeCredentialUtils.ts", symbol: "credentialFieldsFor" },
      ],
      note: "Read to render the credential form and pick the primary token value.",
    },
    settingsScopeRef: {
      mode: "cross-reference",
      consumers: [{ file: PLUGIN_SCHEMA, symbol: "getPluginManifestSchema superRefine (#10620)" }],
      note: "Validated against a declared contributes.settings id; a dangling ref is a parse error.",
    },
    viewRefs: {
      mode: "cross-reference",
      consumers: [{ file: PLUGIN_SCHEMA, symbol: "getPluginManifestSchema superRefine (#10620)" }],
      note: "Validated against declared contributes.views ids and frozen into the descriptor.",
    },
    slots: {
      mode: "verbatim",
      consumers: [{ file: CODE_FORGE_TAB, symbol: "CodeForgeSettingsTab (slot resolution)" }],
      note: "Resolved to renderer view ids for the provider's UI slots.",
    },
  },
  fileDecorationProviders: {
    id: {
      mode: "verbatim",
      consumers: [
        {
          file: "electron/services/fileDecorationRegistry.ts",
          symbol: "registerFileDecorationProviders",
        },
      ],
      note: "Keys the file-decoration provider descriptor.",
    },
    scopes: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SERVICE, symbol: "scopeMatchesPattern routing" }],
      note: "Matched to route renderer decoration pulls to the provider.",
    },
  },
  agents: {
    id: {
      mode: "verbatim",
      consumers: [{ file: AGENT_REGISTRY, symbol: "registerPluginAgents" }],
      note: "Keys the registered plugin agent config.",
    },
    name: {
      mode: "verbatim",
      consumers: [{ file: AGENT_REGISTRY, symbol: "toPluginAgentConfig" }],
      note: "Copied into the runtime agent config display name.",
    },
    command: {
      mode: "verbatim",
      consumers: [{ file: AGENT_REGISTRY, symbol: "resolvePluginAgentCommand" }],
      note: "Resolved against the plugin dir and spawned as the agent CLI.",
    },
    args: {
      mode: "verbatim",
      consumers: [{ file: AGENT_REGISTRY, symbol: "toPluginAgentConfig" }],
      note: "Copied into the runtime agent config argv.",
    },
    color: {
      mode: "verbatim",
      consumers: [{ file: AGENT_REGISTRY, symbol: "toPluginAgentConfig" }],
      note: "Copied into the runtime agent config color.",
    },
    iconId: {
      mode: "verbatim",
      consumers: [{ file: AGENT_REGISTRY, symbol: "toPluginAgentConfig" }],
      note: "Copied into the runtime agent config icon.",
    },
    supportsContextInjection: {
      mode: "verbatim",
      consumers: [{ file: AGENT_REGISTRY, symbol: "toPluginAgentConfig" }],
      note: "Copied into the runtime agent config context-injection flag.",
    },
    detection: {
      mode: "verbatim",
      consumers: [{ file: AGENT_REGISTRY, symbol: "toPluginAgentConfig" }],
      note: "Copied into the runtime agent config detection block (see agents.detection).",
    },
  },
  processTools: {
    command: {
      mode: "verbatim",
      consumers: [
        { file: PROCESS_TOOL_REGISTRY, symbol: "registerPluginProcessTools (snapshot key)" },
        { file: PROCESS_DETECTOR_REGISTRIES, symbol: "getProcessIconMap" },
      ],
      note: "Keys the flattened command → icon snapshot the pty-host detector looks a running process up by.",
    },
    iconId: {
      mode: "derived-input",
      consumers: [
        { file: PROCESS_TOOL_REGISTRY, symbol: "registerPluginProcessTools (snapshot value)" },
        { file: "src/components/Terminal/TerminalIcon.tsx", symbol: "getPluginIconComponent" },
      ],
      note: "Collapsed to the generic `terminal` glyph unless it names a PLUGIN_ICON_ID, then emitted as the detected process icon id — the id doubles as process identity, so an unsanitized value could borrow a built-in agent's mark or a built-in tool's detection priority.",
    },
  },
  settings: {
    id: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SETTINGS_FORM, symbol: "PluginSettingField (def.id)" }],
      note: "Keys the stored setting value and form field.",
    },
    type: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SETTINGS_FORM, symbol: "settingType (def.type)" }],
      note: "Selects the rendered control and value coercion.",
    },
    label: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SETTINGS_FORM, symbol: "PluginSettingField (def.label)" }],
      note: "Rendered as the setting label.",
    },
    description: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SETTINGS_FORM, symbol: "PluginSettingField (def.description)" }],
      note: "Rendered as the setting help text.",
    },
    default: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SETTINGS_FORM, symbol: "PluginSettingField (def.default)" }],
      note: "Seeds the control's initial/reset value.",
    },
    scope: {
      mode: "verbatim",
      consumers: [
        {
          file: "electron/services/plugin/PluginSettingsManager.ts",
          symbol: "PluginSettingsManager",
        },
      ],
      note: "Selects the user vs project storage scope.",
    },
    options: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SETTINGS_FORM, symbol: "PluginSettingField (def.options)" }],
      note: "Rendered as the enum select options.",
    },
    min: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SETTINGS_FORM, symbol: "PluginSettingField (def.min)" }],
      note: "Enforced as the numeric minimum on input.",
    },
    max: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SETTINGS_FORM, symbol: "PluginSettingField (def.max)" }],
      note: "Enforced as the numeric maximum on input.",
    },
    mustExist: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SETTINGS_FORM, symbol: "PluginSettingField (def.mustExist)" }],
      note: "Drives the advisory path-existence check for path/file settings.",
    },
    extensions: {
      mode: "verbatim",
      consumers: [{ file: PLUGIN_SETTINGS_FORM, symbol: "PluginSettingField (def.extensions)" }],
      note: "Passed as the native file-chooser extension filter.",
    },
    secret: {
      mode: "derived-input",
      consumers: [
        { file: PLUGIN_SCHEMA, symbol: "SettingDefinitionSchema transform (→ type 'secret')" },
      ],
      note: "Normalized into type: 'secret' by the schema; also read directly by the form.",
    },
  },
  "agents.detection": {
    primaryPatterns: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildPatternConfig" }],
      note: "Compiled into the working-state detector's primary patterns.",
    },
    fallbackPatterns: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildPatternConfig" }],
      note: "Compiled into the detector's fallback patterns.",
    },
    bootCompletePatterns: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildBootCompletePatterns" }],
      note: "Compiled into the boot-complete detector patterns.",
    },
    promptPatterns: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildPromptPatterns" }],
      note: "Compiled into the prompt detector patterns.",
    },
    promptHintPatterns: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildPromptHintPatterns" }],
      note: "Compiled into the prompt-hint detector patterns.",
    },
    completionPatterns: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildCompletionPatterns" }],
      note: "Compiled into the completion detector patterns.",
    },
    scanLineCount: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildPatternConfig" }],
      note: "Passed as the pattern detector's scan-line window.",
    },
    promptScanLineCount: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildActivityMonitorOptions" }],
      note: "Passed as the prompt detector's scan-line window.",
    },
    debounceMs: {
      mode: "verbatim",
      consumers: [
        {
          file: TERMINAL_ACTIVITY_PATTERNS,
          symbol: "buildActivityMonitorOptions (idleDebounceMs)",
        },
      ],
      note: "Floors the idle debounce for the waiting-state transition.",
    },
    promptFastPathMinQuietMs: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildActivityMonitorOptions" }],
      note: "Floors the prompt fast-path quiet window.",
    },
    primaryConfidence: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildPatternConfig" }],
      note: "Passed as the primary-tier confidence weight.",
    },
    fallbackConfidence: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildPatternConfig" }],
      note: "Passed as the fallback-tier confidence weight.",
    },
    promptConfidence: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildActivityMonitorOptions" }],
      note: "Passed as the prompt-tier confidence weight.",
    },
    completionConfidence: {
      mode: "verbatim",
      consumers: [{ file: TERMINAL_ACTIVITY_PATTERNS, symbol: "buildActivityMonitorOptions" }],
      note: "Passed as the completion-tier confidence weight.",
    },
    titleStatePatterns: {
      mode: "verbatim",
      consumers: [
        {
          file: "src/services/terminal/TerminalListenerInstaller.ts",
          symbol: "TerminalListenerInstaller",
        },
      ],
      note: "Read to drive title-based working/waiting state detection.",
    },
  },
  "forgeProviders.credentialFields": {
    id: {
      mode: "verbatim",
      consumers: [{ file: CODE_FORGE_TAB, symbol: "CredentialFieldsForm (field.id)" }],
      note: "Keys the entered value and the primary-value pick.",
    },
    label: {
      mode: "verbatim",
      consumers: [{ file: CODE_FORGE_TAB, symbol: "CredentialFieldsForm (field.label)" }],
      note: "Rendered as the credential field label.",
    },
    type: {
      mode: "verbatim",
      consumers: [{ file: CODE_FORGE_TAB, symbol: "CredentialFieldsForm (field.type)" }],
      note: "Selects password masking and the primary-value field.",
    },
    placeholder: {
      mode: "verbatim",
      consumers: [{ file: CODE_FORGE_TAB, symbol: "CredentialFieldsForm (field.placeholder)" }],
      note: "Rendered as the credential input placeholder.",
    },
    helpText: {
      mode: "verbatim",
      consumers: [{ file: CODE_FORGE_TAB, symbol: "CredentialFieldsForm (field.helpText)" }],
      note: "Rendered as the credential field help text.",
    },
  },
  "forgeProviders.slots": {
    settingsTab: {
      mode: "verbatim",
      consumers: [{ file: CODE_FORGE_TAB, symbol: "CodeForgeSettingsTab (settingsTab slot)" }],
      note: "Resolved to the provider's settings-tab renderer view.",
    },
    icon: {
      mode: "verbatim",
      consumers: [{ file: CODE_FORGE_TAB, symbol: "CodeForgeSettingsTab (icon slot)" }],
      note: "Resolved to the provider's icon renderer view.",
    },
    statsDropdown: {
      mode: "verbatim",
      consumers: [
        {
          file: "src/components/Layout/ForgeStatsToolbarButton.tsx",
          symbol: "ForgeStatsToolbarButton",
        },
      ],
      note: "Resolved to the provider's stats-dropdown renderer view.",
    },
    bulkCreateWorktreeDialog: {
      mode: "verbatim",
      consumers: [{ file: "src/components/Sidebar/SidebarContent.tsx", symbol: "SidebarContent" }],
      note: "Resolved to the provider's bulk-create-worktree dialog view.",
    },
    issueSelector: {
      mode: "verbatim",
      consumers: [
        {
          file: "src/components/Worktree/views/IssueSelectorView.tsx",
          symbol: "IssueSelectorView",
        },
      ],
      note: "Resolved to the provider's issue-selector renderer view.",
    },
  },
} satisfies FieldConsumerCoverage;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function parseEmptyContributes() {
  return getPluginManifestSchema(false).safeParse({
    name: "acme.consumer-contract",
    version: "1.0.0",
    contributes: {},
  });
}

describe("manifest contribution field → consumer contract (#10888)", () => {
  it("maps a consumer for every contributes.* contribution kind", () => {
    // Guard against a new contribution kind being added to the schema without a
    // matching swept schema + consumer group (mirrors contributionCaps.test.ts).
    const parsed = parseEmptyContributes();
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    for (const key of Object.keys(parsed.data.contributes)) {
      expect(SWEPT_SCHEMAS).toHaveProperty(key);
      expect(MANIFEST_CONTRIBUTION_FIELD_CONSUMERS).toHaveProperty(key);
    }
    // Exact set match against the parsed empty manifest: a new contribution kind
    // shows up here (every contributes.* array is `.default([])`, so an empty
    // manifest materializes them all) and forces a swept-schema + consumer entry;
    // a removed kind can't leave a stale group behind. Caveat: a future kind
    // declared `.optional()` WITHOUT a default would not appear on the empty
    // parse and would slip this guard — the `.default([])` convention on every
    // array kind (see MANIFEST_CONTRIBUTION_CAPS) is what keeps that watertight.
    expect(Object.keys(parsed.data.contributes).sort()).toEqual([...TOP_LEVEL_GROUPS].sort());
  });

  it.each(Object.keys(SWEPT_SCHEMAS) as SweptGroup[])(
    "declares a consumer for every field the %s schema accepts",
    (group) => {
      const schemaFields = shapeKeys(SWEPT_SCHEMAS[group]);
      const mappedFields = Object.keys(MANIFEST_CONTRIBUTION_FIELD_CONSUMERS[group]).sort();
      // Exact match in BOTH directions: a new schema field with no consumer
      // (missing here) and a stale map entry for a removed field (extra here)
      // both fail — the field set and its documented consumers can't drift.
      expect(mappedFields).toEqual(schemaFields);
    }
  );

  const allDescriptors: { group: SweptGroup; field: string; descriptor: ConsumerDescriptor }[] = (
    Object.keys(SWEPT_SCHEMAS) as SweptGroup[]
  ).flatMap((group) =>
    Object.entries(MANIFEST_CONTRIBUTION_FIELD_CONSUMERS[group]).map(([field, descriptor]) => ({
      group,
      field,
      descriptor,
    }))
  );

  it.each(allDescriptors)(
    "records a concrete, existing consumer for $group.$field",
    ({ descriptor }) => {
      expect(ALL_MODES).toContain(descriptor.mode);
      expect(descriptor.note.trim().length).toBeGreaterThan(0);
      expect(descriptor.consumers.length).toBeGreaterThan(0);
      for (const consumer of descriptor.consumers) {
        expect(consumer.symbol.trim().length).toBeGreaterThan(0);
        // A consumer must live in first-party source (main, renderer, shared) or
        // the first-party plugin SDK/tooling — not point at a plugin or nowhere.
        expect(consumer.file).toMatch(/^(electron|src|shared|packages)\//);
        expect(existsSync(join(REPO_ROOT, consumer.file))).toBe(true);
      }
    }
  );
});
