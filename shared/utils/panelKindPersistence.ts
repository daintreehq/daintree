import {
  isProjectQualifiedPanelKindId,
  toPersistedPanelKindRef,
  toRuntimePanelKindId,
  type PersistedPanelKindRef,
} from "../config/panelKindRegistry.js";
import type { PanelKind } from "../types/panel.js";

/**
 * The `kind`/`kindRef` pair a layout persists for one panel (#12280).
 *
 * `kind` is always the PORTABLE runtime form — byte-identical to the live id
 * for a built-in or a global plugin kind, and the project id stripped off for a
 * project-local one. `kindRef` carries the origin/manifest/bare-kind triple
 * restore re-qualifies from, and is written only for plugin-owned kinds.
 */
export interface PersistedKindFields {
  kind: PanelKind;
  kindRef?: PersistedPanelKindRef;
}

/**
 * Unqualify a live runtime panel kind into what a layout should store.
 *
 * A project-local plugin registers its kinds as
 * `project:{projectId}/{manifestId}/{kindId}`, so persisting the runtime id
 * verbatim writes a machine-local project id into the layout. The layout then
 * only resolves under the identity that wrote it, and moving, exporting or
 * reusing it orphans every plugin panel in it (#12280).
 *
 * `pluginOwned` gates the conversion rather than trusting the shape of the id:
 * an unregistered non-plugin kind can contain a dot too (a built-in removed in
 * code, a kind a test invents), and speculatively minting a `kindRef` for one
 * would claim a plugin owns state it never wrote. Callers pass the registry's
 * verdict — a registered `extensionId`, a creation-time `pluginId` stamp, or a
 * project-qualified id, each of which means a plugin contributed this kind.
 *
 * `pluginManifestIdHint` disambiguates the global form for a manifest id that
 * predates the scoped-name rule. Passing a project plugin's INSTANCE key is
 * harmless: the project form parses on its slashes and ignores the hint, and
 * for a global plugin the instance key already is the manifest id.
 */
export function toPersistedKindFields(
  runtimeKind: PanelKind,
  pluginOwned: boolean,
  pluginManifestIdHint?: string
): PersistedKindFields {
  if (!pluginOwned) return { kind: runtimeKind };
  const ref = toPersistedPanelKindRef(runtimeKind, pluginManifestIdHint);
  if (ref === null) return { kind: runtimeKind };
  return { kind: `${ref.pluginId}.${ref.kindId}`, kindRef: ref };
}

/** The persisted-kind half of a snapshot — as much of it as any reader needs. */
export interface PersistedKindSource {
  kind?: PanelKind;
  kindRef?: PersistedPanelKindRef;
}

/**
 * Stand-in project id for a project-local kind restored with no project in
 * scope.
 *
 * The portable form of a project kind is byte-identical to the runtime form of
 * a global one, so handing it back unqualified would let `getPanelKindConfig`
 * resolve it to an installed GLOBAL plugin of the same manifest and kind id —
 * a real configuration, since keeping a plugin installed globally while
 * developing it in `.daintree/plugins` is the ordinary way to work on one. The
 * panel would then mount a different plugin's view over this panel's state, and
 * that view could persist into it. The registry's own delimiter comment names
 * this hazard: an unqualified project ref aliases onto a global kind.
 *
 * NUL is the joiner this codebase already relies on being unforgeable (see the
 * resume-election keys in `panelRestorePhase`), so no real project can carry
 * this id and no registry entry can answer for the qualified result. The id
 * stays parseable, so it survives the round trip: unqualifying it again yields
 * the original ref, and the next save writes the correct portable form back.
 */
const UNRESOLVED_PROJECT_ID = "\u0000unresolved";

/**
 * Qualify a persisted kind against the project it is being restored INTO.
 *
 * Three shapes reach this and all three must land on the same runtime id:
 * - `kindRef` present (current format) — re-qualified against `projectId`.
 * - `kind` still carrying `project:{projectId}/...` (written before #12280) —
 *   parsed on its slashes and re-qualified, which is the migration: a layout
 *   opened under a different identity adopts that identity instead of
 *   resolving to nothing.
 * - anything else — returned untouched.
 *
 * Idempotent, so a snapshot Main already re-qualified survives the renderer's
 * own restore path unchanged.
 *
 * A project ref with no project in scope is qualified against
 * {@link UNRESOLVED_PROJECT_ID} instead of being handed back portable. Either
 * way no registry entry answers for the result, which is exactly the input the
 * restore guard treats as a missing plugin — the panel keeps its record and its
 * `extensionState` rather than being dropped (#5580, #5629) — but the sentinel
 * cannot be mistaken for a global kind on the way there.
 */
export function requalifyPersistedKind(
  saved: PersistedKindSource,
  projectId: string | null | undefined
): PanelKind | undefined {
  const kind = saved.kind;
  if (kind === undefined) return undefined;
  const ref =
    saved.kindRef ?? (isProjectQualifiedPanelKindId(kind) ? toPersistedPanelKindRef(kind) : null);
  if (ref === null || ref === undefined) return kind;
  const qualified = toRuntimePanelKindId(ref, projectId ?? null);
  if (qualified !== null) return qualified;
  // Only a project ref reaches here, and only with no project to qualify it
  // against. Returning the portable form would alias it onto a global kind of
  // the same name, so qualify it against an id nothing can be registered under.
  return toRuntimePanelKindId(ref, UNRESOLVED_PROJECT_ID) ?? kind;
}

/**
 * Stable identity for "which kind is this snapshot for", comparable across the
 * format change.
 *
 * `panelToSnapshot` preserves an unregistered kind's fields from the previous
 * snapshot only while that snapshot is for the same panel AND the same kind
 * (#8960, #5342). Comparing the raw strings breaks twice over here: the live
 * runtime id no longer equals the persisted one for a project kind, and the
 * first save after an upgrade compares a legacy `project:`-qualified string
 * against a freshly portable one. Both normalize to the same key.
 */
export function persistedKindKey(saved: PersistedKindSource): string {
  const kind = saved.kind ?? "";
  const ref = saved.kindRef ?? toPersistedPanelKindRef(kind);
  if (ref === null || ref === undefined) return `raw ${kind}`;
  return `${ref.origin} ${ref.pluginId} ${ref.kindId}`;
}
