// Provider contributions: forge, element picker, context, file decoration, worktree delete notes and file editors.

import { z } from "zod";
import { SAFE_ID_PATTERN } from "../pluginIdentifiers.js";
import {
  ELEMENT_PICKER_DETECTION_KINDS,
  ELEMENT_PICKER_PROVIDER_LIMITS,
} from "../../../shared/elementPicker/providers.js";
import { isCoreFramework } from "../../../shared/elementPicker/source.js";
import {
  CONTEXT_PROVIDER_PREFIX_PATTERN,
  CONTEXT_PROVIDER_RESERVED_PREFIXES,
} from "../../../shared/utils/pluginContextReference.js";
import { isSafePluginAssetPath } from "./common.js";

/** Most `paths` patterns one `fileEditors` entry may declare. */
export const FILE_EDITOR_MAX_PATH_PATTERNS = 20;

/**
 * A project-relative glob a project plugin's file editor claims (#13809).
 * Forward slashes only, relative to the project or worktree root, and no way
 * out of it: no leading `/`, no drive letter, no `..` segment, no backslash,
 * no NUL, and no `!` negation (a claim says what it edits, never what it
 * doesn't).
 */
export const FileEditorPathPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (pattern) =>
      !pattern.startsWith("/") &&
      !pattern.startsWith("!") &&
      !/^[a-zA-Z]:/.test(pattern) &&
      !pattern.includes("\\") &&
      !pattern.includes("\0") &&
      !pattern.split("/").includes(".."),
    {
      message:
        "paths are project-relative globs with forward slashes — no leading /, drive letter, .. segment, backslash or ! negation",
    }
  );

/** Bare lower-case suffixes without the dot, shared by `fileEditors` and file context-menu matching. */
export const FileExtensionListSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(16)
      .regex(/^[a-z0-9]+$/, "extensions are bare lower-case suffixes without the dot")
  )
  .min(1)
  .max(20);

/**
 * One credential input rendered into the provider's settings form. `type` is a
 * free string (`"password"` masks the input; anything else renders plain
 * text). A provider may declare several fields, but only the primary value
 * reaches `validateToken` — see `ForgeProviderContribution.credentialFields`
 * in `shared/types/forge.ts` for the single-primary contract.
 */
const RESERVED_CREDENTIAL_FIELD_IDS = new Set(["__proto__", "constructor", "prototype"]);

export const CredentialFieldSchema = z
  .object({
    // A field id keys the entered value into a plain record at save time; a
    // reserved key (`__proto__` etc.) would resolve to the object prototype
    // rather than a stored string and crash the primary-value pick. Reject up
    // front, mirroring AgentContributionSchema.
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(SAFE_ID_PATTERN)
      .refine((id) => !RESERVED_CREDENTIAL_FIELD_IDS.has(id), {
        message: "Credential field id cannot be a reserved key (__proto__, constructor, prototype)",
      }),
    label: z.string().min(1),
    type: z.string().min(1),
    placeholder: z.string().optional(),
    helpText: z.string().optional(),
  })
  .strict();

/**
 * `forgeProviders` manifest entry — wired: the registry populates Preferences
 * and remote-routing before any plugin code runs. See
 * `docs/architecture/forge-provider-abstraction.md`. `settingsScopeRef` and
 * `viewRefs` are cross-validated against `contributes.settings`/`contributes.views`
 * by the manifest-level `superRefine` (#10620) — a dangling ref is a parse
 * error. Two fields are validated for SHAPE only and carry no runtime authority
 * (frozen at 1.0):
 *   - `capabilities` is informational; the host gates behavior on the runtime
 *     `ForgeProviderImpl` field presence, never on these strings.
 *   - `slots` values are opaque renderer view-ids checked for non-emptiness
 *     only; the main process can't verify them against the renderer registry,
 *     and an unresolved ref renders a neutral fallback (not a parse error).
 */
export const ForgeProviderContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    matches: z.array(z.string().min(1)),
    roles: z
      .array(z.enum(["issues", "code"]))
      .min(1)
      .optional(),
    kind: z.enum(["local", "network"]).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    credentialFields: z.array(CredentialFieldSchema).optional(),
    settingsScopeRef: z.string().min(1).optional(),
    viewRefs: z.array(z.string().min(1)).optional(),
    slots: z
      .object({
        settingsTab: z.string().min(1).optional(),
        icon: z.string().min(1).optional(),
        statsDropdown: z.string().min(1).optional(),
        bulkCreateWorktreeDialog: z.string().min(1).optional(),
        issueSelector: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((contribution, ctx) => {
    const roles = contribution.roles;
    if (roles && new Set(roles).size !== roles.length) {
      ctx.addIssue({ code: "custom", path: ["roles"], message: "roles must not repeat a role" });
    }
    // Code-only isn't routable yet: every code surface reads a full provider,
    // and the workspace host fetches branch-linked issue titles from the code
    // provider. Issues-only (#13700) and both are the supported shapes.
    if (roles && !roles.includes("issues")) {
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message: 'roles must include "issues" — a code-only provider is not supported',
      });
    }
    // Hostname matching routes the code role, so a provider serving code
    // must be reachable through it; an issues-only provider has no remote.
    const servesCode = !roles || roles.includes("code");
    // ...and an issues-only provider must not be: hostnames route the code
    // role, so a listed one would put it in the code forge's place.
    if (!servesCode && contribution.matches.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["matches"],
        message: "matches must be empty for an issues-only provider",
      });
    }
    if (servesCode && contribution.matches.length === 0) {
      ctx.addIssue({
        code: "too_small",
        origin: "array",
        minimum: 1,
        inclusive: true,
        path: ["matches"],
        message: "matches must list at least one hostname for a provider that serves code",
      });
    }
  });

/**
 * `elementPickerProviders` manifest entry (#14073): a framework the core
 * Element Picker can recognise, declared so it is known before any plugin code
 * runs. Detection is a flat list of marker names compared exactly or by prefix,
 * with no plugin-supplied regex, selector or script. `guestEntry` and
 * `resolverEntry` are packaged paths the host will load in later work. The local
 * `id` is lowercase and may not be a core framework name; the registry
 * namespaces it as `{manifest.name}.{id}`.
 */
const ELEMENT_PICKER_LOCAL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ELEMENT_PICKER_MARKER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$:.-]*$/;

export const ElementPickerDetectionRuleSchema = z
  .object({
    kind: z.enum(ELEMENT_PICKER_DETECTION_KINDS),
    name: z
      .string()
      .min(1)
      .max(ELEMENT_PICKER_PROVIDER_LIMITS.markerNameLength)
      .regex(ELEMENT_PICKER_MARKER_PATTERN, {
        message: "marker names use letters, digits and _ $ - : . only",
      }),
    match: z.enum(["exact", "prefix"]),
  })
  .strict();

export const ElementPickerProviderContributionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(ELEMENT_PICKER_LOCAL_ID_PATTERN, {
        message: "id is lowercase letters and digits, optionally hyphen-separated",
      })
      .refine((id) => !isCoreFramework(id), {
        message: "id can't be a core framework name, which Daintree reserves",
      }),
    name: z.string().trim().min(1).max(80),
    detection: z
      .array(ElementPickerDetectionRuleSchema)
      .min(1)
      .max(ELEMENT_PICKER_PROVIDER_LIMITS.rulesPerProvider),
    guestEntry: z
      .string()
      .min(1)
      .max(ELEMENT_PICKER_PROVIDER_LIMITS.entryPathLength)
      .refine(isSafePluginAssetPath, { message: "guestEntry must be a plugin-relative path" }),
    resolverEntry: z
      .string()
      .min(1)
      .max(ELEMENT_PICKER_PROVIDER_LIMITS.entryPathLength)
      .refine(isSafePluginAssetPath, { message: "resolverEntry must be a plugin-relative path" })
      .optional(),
  })
  .strict();

/**
 * `contextProviders` manifest entry (#13795): an `@{prefix}:` the agent
 * composer offers, answered by the impl the plugin binds through
 * `host.registerContextProvider`. Declared so a project's prefixes are known
 * before any plugin code runs. No capability: the host asks only after the
 * user picks, and nothing is ever sent without their Enter. Strict so unknown
 * fields fail loudly.
 */
export const ContextProviderContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    prefix: z
      .string()
      .regex(CONTEXT_PROVIDER_PREFIX_PATTERN, {
        message: "prefix is one to sixteen lowercase letters",
      })
      .refine((prefix) => !CONTEXT_PROVIDER_RESERVED_PREFIXES.has(prefix), {
        message: "prefix can't be diff, terminal or selection, which the composer reserves",
      }),
    label: z.string().min(1).max(60),
  })
  .strict();

/**
 * `fileDecorationProviders` manifest entry. Declares which scopes a plugin's
 * decoration provider handles so the host can route renderer pulls without
 * the plugin's code having run yet. Strict so unknown fields from plugin
 * authors are rejected loudly rather than silently ignored.
 */
export const FileDecorationContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    scopes: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * `worktreeDeleteNotes` manifest entry (#13805). Declared so the host can find,
 * and activate, the plugin that adds notes to a worktree's delete confirmation
 * before any of its code has run.
 */
export const WorktreeDeleteNotesContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  })
  .strict();

/**
 * Largest file a `contributes.fileEditors` entry may claim. Above this the
 * renderer holds the whole document in a CodeMirror buffer plus a draft copy,
 * so the ceiling is a memory bound, not a product limit — the built-in
 * Markdown editor asks for 2 MiB.
 */
export const FILE_EDITOR_MAX_BYTES_CEILING = 64 * 1024 * 1024;

/**
 * `fileEditors` manifest entry (#12323, #13809). Two forms, exactly one of
 * `slot` / `view`:
 *
 * - `slot` names the builtin view a built-in plugin's renderer registers for
 *   the file panel's Edit mode. Built-in plugins only — the slot resolves
 *   through the host-bundled builtin view registry. Enforced at load, where
 *   the origin is known.
 * - `view` names one of the plugin's own `location: "fileEditor"` views, and
 *   `mode` says what it fills: `"edit"` the file panel's Edit mode, `"view"`
 *   its Rendered mode for a type the host cannot render. Open to every origin.
 *
 * `extensions` are bare lower-case suffixes; `paths` are project-relative
 * globs, accepted from project plugins only (checked in the manifest
 * refinement). `default` makes a project plugin's Edit editor what its `paths`
 * open in (#13811), also checked there. Strict so a misspelt field is a
 * manifest error, not a silently missing mode.
 */
export const FileEditorContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    slot: z.string().min(1).max(128).regex(SAFE_ID_PATTERN).optional(),
    view: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    mode: z.enum(["edit", "view"]).optional(),
    extensions: FileExtensionListSchema.optional(),
    paths: z
      .array(FileEditorPathPatternSchema)
      .min(1)
      .max(FILE_EDITOR_MAX_PATH_PATTERNS)
      .optional(),
    default: z.boolean().optional(),
    maxBytes: z.number().int().positive().max(FILE_EDITOR_MAX_BYTES_CEILING).optional(),
  })
  .strict();
