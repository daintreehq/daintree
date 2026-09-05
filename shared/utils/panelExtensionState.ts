/**
 * The version a bag written before #12280 is treated as. Nothing stamped one,
 * so its shape is whatever the plugin happened to be writing at the time — the
 * plugin is the only thing that can know, which is why v0 is handed through
 * rather than refused.
 */
export const LEGACY_PANEL_EXTENSION_STATE_VERSION = 0;

/**
 * The outcome of reading a panel's `extensionState` back.
 *
 * `ok: false` still carries the state, because refusing it is never a licence
 * to drop it: the bag stays on the panel record and keeps round-tripping
 * through saves untouched, so downgrading a plugin and upgrading it again
 * returns the user's state intact.
 */
export type PanelExtensionStateDecode =
  | { ok: true; state: Record<string, unknown> | undefined; version: number }
  | {
      ok: false;
      reason: "future-version";
      state: Record<string, unknown>;
      persistedVersion: number;
      declaredVersion: number;
    };

export interface PanelExtensionStateInput {
  /** The persisted bag, or `undefined` for a panel that never stored one. */
  state?: Record<string, unknown>;
  /** `PanelSnapshot.extensionStateVersion` exactly as it came off disk. */
  persistedVersion?: number;
  /** `contributes.panels[].stateVersion` of the kind as currently registered. */
  declaredVersion?: number;
}

function readVersion(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

/**
 * Decide whether a persisted plugin panel bag may be handed to the view that
 * owns it (#12280).
 *
 * Total by construction — it never throws and never returns a default that
 * silently stands in for real state, because the caller's alternative is to
 * hand a plugin a bag written against a schema it no longer understands and let
 * it corrupt or discard the user's state on the next write.
 *
 * The contract, following `projectSettingsCodec`:
 * - No bag, or a plugin that declares no version: nothing to judge, pass it on.
 *   An unregistered kind lands here too, and must — the placeholder path
 *   preserves the bag without ever showing it to anyone.
 * - No persisted version: legacy v0, migrated forward by handing the plugin the
 *   bag along with the version it was read at, so the plugin can upgrade it and
 *   re-stamp it on its next write.
 * - Persisted version at or below what the plugin declares: the plugin's own
 *   migration contract covers it. It is told which version it is reading.
 * - Persisted version ABOVE what the plugin declares: refused. This is a
 *   downgrade — the bag was written by a newer build of the plugin — and the
 *   only honest outcomes are an error the user can act on or silent data loss.
 *
 * A plugin cannot forge its way past this: the version is a sibling of
 * `extensionState` on the panel record, and the write gate
 * (`setPanelExtensionState`) stamps it from the registry rather than from the
 * plugin's patch, which only ever reaches inside the bag.
 */
export function decodePanelExtensionState(
  input: PanelExtensionStateInput
): PanelExtensionStateDecode {
  const declaredVersion = readVersion(input.declaredVersion);
  const persistedVersion =
    readVersion(input.persistedVersion) ?? LEGACY_PANEL_EXTENSION_STATE_VERSION;

  if (input.state === undefined || declaredVersion === undefined) {
    return { ok: true, state: input.state, version: persistedVersion };
  }

  if (persistedVersion > declaredVersion) {
    return {
      ok: false,
      reason: "future-version",
      state: input.state,
      persistedVersion,
      declaredVersion,
    };
  }

  return { ok: true, state: input.state, version: persistedVersion };
}

/**
 * What to tell the user when a panel's saved state is newer than the plugin
 * that owns it. Names both versions, because the action ("get the newer plugin
 * back") is only obvious once you can see which direction the mismatch runs in.
 */
export function panelExtensionStateVersionMessage(
  pluginDisplayName: string,
  persistedVersion: number,
  declaredVersion: number
): string {
  return `This panel's saved state was written by a newer version of the ${pluginDisplayName} plugin (state format ${persistedVersion}; this version reads ${declaredVersion}). Update the plugin to open it. The saved state is kept until then.`;
}
