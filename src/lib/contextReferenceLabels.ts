import { formatContextReference } from "@shared/utils/pluginContextReference";
import type { ContextReference } from "@shared/types/pluginContextProvider";

/**
 * The names of context items this view has seen (#13795), so a chip can read
 * "Fix login bug" rather than the opaque `@rec:142` the draft holds. Learned
 * from the `@` menu's rows and from dropped references; a reference typed by
 * hand or recalled after a restart has no name here and its chip shows the id.
 * Display only — the draft text and what resolves never depend on it.
 *
 * Keyed by the plugin that named the item as well as the reference: when
 * another plugin comes to hold the prefix, the first one's names don't stick
 * to its chips.
 */
const MAX_LABELS = 500;
const labels = new Map<string, string>();

function labelKey(pluginId: string, reference: ContextReference): string {
  // Neither a plugin id nor a reference holds a space.
  return `${pluginId} ${formatContextReference(reference)}`;
}

export function rememberContextReferenceLabel(
  pluginId: string,
  reference: ContextReference,
  label: string
): void {
  const key = labelKey(pluginId, reference);
  // Re-inserted so the most recently seen names are the last to be evicted.
  labels.delete(key);
  labels.set(key, label);
  if (labels.size > MAX_LABELS) {
    const oldest = labels.keys().next().value;
    if (oldest !== undefined) labels.delete(oldest);
  }
}

export function contextReferenceLabel(
  pluginId: string,
  reference: ContextReference
): string | undefined {
  return labels.get(labelKey(pluginId, reference));
}

/** Test seam. */
export function clearContextReferenceLabelsForTests(): void {
  labels.clear();
}
