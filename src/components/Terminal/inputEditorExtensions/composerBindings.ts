import { StateEffect, type Compartment, type EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

interface ComposerBindings {
  extensions: Extension;
  compartments: readonly Compartment[];
}

const bindingsByView = new WeakMap<EditorView, ComposerBindings>();

/** What a composer built its editor from, for a state brought in from elsewhere to take on. */
export function recordComposerBindings(view: EditorView, bindings: ComposerBindings): void {
  bindingsByView.set(view, bindings);
}

/**
 * A state kept since an earlier editor (a stash) carries that composer's update
 * listener, keymap and compartments, and the composer may have unmounted since:
 * shown as it is, typing would reach the composer that's gone, and Enter would
 * send what it last held. This keeps its text, selection and undo history on the
 * composer showing it now, with that composer's compartments as they stand.
 */
export function rebindToComposer(view: EditorView, state: EditorState): EditorState {
  const bindings = bindingsByView.get(view);
  if (!bindings) return state;
  return state.update({
    effects: [
      StateEffect.reconfigure.of(bindings.extensions),
      ...bindings.compartments.map((compartment) =>
        compartment.reconfigure(compartment.get(view.state) ?? [])
      ),
    ],
  }).state;
}
