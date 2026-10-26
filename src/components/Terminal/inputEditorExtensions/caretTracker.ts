import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { forgetComposerState, recordComposerState } from "@/lib/composerCaret";

/**
 * Publishes the composer's selection for dictation to start at, under the
 * draft key `draftKey()` names when it runs. Nothing is published until the
 * composer has had focus: a draft the user never clicked into has a caret at
 * 0 they never chose. After that it stays published while focus is elsewhere,
 * since pressing the mic button takes focus with it.
 */
export function createCaretTracker(draftKey: () => string) {
  return ViewPlugin.define((view) => {
    let focused = view.hasFocus;
    let key: string | null = null;
    const publish = (state: typeof view.state) => {
      const next = draftKey();
      if (key !== null && key !== next) forgetComposerState(key, view);
      key = next;
      recordComposerState(next, view, state);
    };
    if (focused) publish(view.state);
    return {
      update(update: ViewUpdate) {
        if (update.view.hasFocus) focused = true;
        if (focused) publish(update.state);
      },
      destroy() {
        if (key !== null) forgetComposerState(key, view);
      },
    };
  });
}
