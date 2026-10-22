import { formatContextReference } from "@shared/utils/pluginContextReference";
import type { ContextReference } from "@shared/types/pluginContextProvider";

/**
 * The names of context items this view has seen (#13795), so a chip can read
 * "Fix login bug" rather than the opaque `@rec:142` the draft holds. Learned
 * from the `@` menu's rows and from dropped references; a reference typed by
 * hand or recalled after a restart has no name here and its chip shows the id.
 * Display only — the draft text and what resolves never depend on it.
 */
const MAX_LABELS = 500;
const labels = new Map<string, string>();

export function rememberContextReferenceLabel(reference: ContextReference, label: string): void {
  const key = formatContextReference(reference);
  // Re-inserted so the most recently seen names are the last to be evicted.
  labels.delete(key);
  labels.set(key, label);
  if (labels.size > MAX_LABELS) {
    const oldest = labels.keys().next().value;
    if (oldest !== undefined) labels.delete(oldest);
  }
}

export function contextReferenceLabel(reference: ContextReference): string | undefined {
  return labels.get(formatContextReference(reference));
}

/** Test seam. */
export function clearContextReferenceLabelsForTests(): void {
  labels.clear();
}
