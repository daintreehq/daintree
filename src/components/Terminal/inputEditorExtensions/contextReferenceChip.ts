import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import type { ContextProviderEntry } from "@shared/types/pluginContextProvider";
import { formatContextReference } from "@shared/utils/pluginContextReference";
import { contextReferenceLabel } from "@/lib/contextReferenceLabels";
import { createTrustedHTML, setTrustedInnerHTML } from "@/lib/trustedTypesPolicy";
import { getAllAtContextReferences } from "../hybridInputParsing";
import { chipAriaLabel, chipPendingDeleteField, isChipSelected } from "./chipBackspace";
import { chipCardText, chipHoverTooltip, chipTooltip } from "./chipCard";

/**
 * Chips for plugin context references (#13795): `@rec:142` drawn as the item
 * it names, under the name of the plugin whose provider holds `rec` in this
 * project. Only prefixes a provider holds are drawn; anything else stays text,
 * and goes as typed unless main finds a provider for it at send.
 */

/** What the chip needs to know about the provider holding a prefix. */
export interface ContextReferenceChipProvider {
  pluginId: string;
  pluginName: string;
  label: string;
}

/** Replace the providers the composer draws chips for; dispatched as the project's list changes. */
export const setContextReferenceProviders =
  StateEffect.define<ReadonlyMap<string, ContextReferenceChipProvider>>();

/** What each view was last told, for a state that replaces the view's own. */
const appliedProviders = new WeakMap<
  EditorView,
  ReadonlyMap<string, ContextReferenceChipProvider>
>();

/** Point a view's chips at `providers`, the prefixes held in its project now. */
export function applyContextReferenceProviders(
  view: EditorView,
  providers: ReadonlyMap<string, ContextReferenceChipProvider>
): void {
  appliedProviders.set(view, providers);
  view.dispatch({ effects: setContextReferenceProviders.of(providers) });
}

/**
 * The effect that brings a view's chips back to its current providers after
 * `view.setState` restored an older state (a popped stash), which carries the
 * providers it was stashed with. Empty when none were ever applied.
 */
export function currentContextReferenceProvidersEffects(
  view: EditorView
): StateEffect<ReadonlyMap<string, ContextReferenceChipProvider>>[] {
  const providers = appliedProviders.get(view);
  return providers ? [setContextReferenceProviders.of(providers)] : [];
}

export function contextReferenceChipProviders(
  entries: readonly ContextProviderEntry[]
): ReadonlyMap<string, ContextReferenceChipProvider> {
  const providers = new Map<string, ContextReferenceChipProvider>();
  for (const entry of entries) {
    if (entry.status !== "active") continue;
    providers.set(entry.prefix, {
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      label: entry.label,
    });
  }
  return providers;
}

const PLUG_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>`;

interface ContextChipToken {
  start: number;
  end: number;
  prefix: string;
  id: string;
  provider: ContextReferenceChipProvider;
}

interface ContextChipState {
  providers: ReadonlyMap<string, ContextReferenceChipProvider>;
  tokens: ContextChipToken[];
}

function buildTokens(
  text: string,
  providers: ReadonlyMap<string, ContextReferenceChipProvider>
): ContextChipToken[] {
  if (providers.size === 0) return [];
  const tokens: ContextChipToken[] = [];
  for (const token of getAllAtContextReferences(text)) {
    const provider = providers.get(token.prefix);
    if (provider) tokens.push({ ...token, provider });
  }
  return tokens;
}

function chipDescription(token: ContextChipToken): string {
  return `Attaches its current content from ${token.provider.pluginName} when you send`;
}

class ContextReferenceChipWidget extends WidgetType {
  constructor(
    readonly pluginName: string,
    readonly label: string,
    readonly description: string,
    readonly isSelected: boolean
  ) {
    super();
  }

  eq(other: ContextReferenceChipWidget) {
    return (
      this.pluginName === other.pluginName &&
      this.label === other.label &&
      this.description === other.description &&
      this.isSelected === other.isSelected
    );
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = this.isSelected ? "cm-context-chip cm-chip-pending-delete" : "cm-context-chip";
    span.setAttribute("role", "img");
    span.setAttribute(
      "aria-label",
      chipAriaLabel(`${this.pluginName}: ${this.label}`, this.isSelected)
    );
    span.setAttribute("aria-description", this.description);

    const icon = document.createElement("span");
    setTrustedInnerHTML(icon, createTrustedHTML(PLUG_ICON_SVG));
    icon.style.display = "inline-flex";
    icon.style.alignItems = "center";
    span.appendChild(icon);

    const source = document.createElement("span");
    source.className = "cm-context-chip-source";
    source.setAttribute("aria-hidden", "true");
    source.textContent = this.pluginName;
    span.appendChild(source);

    const label = document.createElement("span");
    label.className = "cm-context-chip-label";
    label.setAttribute("aria-hidden", "true");
    label.textContent = this.label;
    span.appendChild(label);

    return span;
  }

  ignoreEvent() {
    return false;
  }
}

export const contextReferenceChipField = StateField.define<ContextChipState>({
  create(state) {
    const providers = new Map<string, ContextReferenceChipProvider>();
    return { providers, tokens: buildTokens(state.doc.toString(), providers) };
  },
  update(value, tr) {
    let providers = value.providers;
    for (const effect of tr.effects) {
      if (effect.is(setContextReferenceProviders)) providers = effect.value;
    }
    if (!tr.docChanged && providers === value.providers) return value;
    return { providers, tokens: buildTokens(tr.state.doc.toString(), providers) };
  },
  provide: (f) => [
    EditorView.decorations.of((view) => {
      const tokens = drawnTokens(view.state, f);
      if (tokens.length === 0) return Decoration.none;
      const pending = view.state.field(chipPendingDeleteField, false) ?? null;
      return Decoration.set(
        tokens.map((token) =>
          Decoration.replace({
            widget: new ContextReferenceChipWidget(
              token.provider.pluginName,
              contextReferenceLabel(token.provider.pluginId, token) ??
                formatContextReference(token),
              chipDescription(token),
              isChipSelected(pending, token.start, token.end)
            ),
          }).range(token.start, token.end)
        ),
        true
      );
    }),
    EditorView.atomicRanges.of((view) => {
      const tokens = drawnTokens(view.state, f);
      if (tokens.length === 0) return Decoration.none;
      return Decoration.set(
        tokens.map((t) => Decoration.mark({}).range(t.start, t.end)),
        true
      );
    }),
  ],
});

/**
 * The references drawn as chips. One the caret sits after the `@` of — inside
 * it or at its end — with no name known for it, is still being typed (a search
 * query, most likely) and stays text until the user moves on or picks a match.
 */
function drawnTokens(
  state: EditorState,
  field: StateField<ContextChipState> = contextReferenceChipField
): ContextChipToken[] {
  const value = state.field(field, false);
  if (!value || value.tokens.length === 0) return [];
  const caret = state.selection.main;
  return value.tokens.filter(
    (token) =>
      contextReferenceLabel(token.provider.pluginId, token) !== undefined ||
      !caret.empty ||
      caret.head <= token.start ||
      caret.head > token.end
  );
}

/** Whether `start`–`end` overlaps a drawn context chip, so an `@file` chip leaves it alone. */
export function isOwnedByContextReferenceChip(
  state: EditorState,
  start: number,
  end: number
): boolean {
  const value = state.field(contextReferenceChipField, false);
  if (!value) return false;
  return value.tokens.some((token) => token.start < end && token.end > start);
}

export function createContextReferenceChipTooltip() {
  return chipHoverTooltip((view, pos) => {
    const token = drawnTokens(view.state).find((t) => pos >= t.start && pos < t.end);
    if (!token) return null;
    return chipTooltip({ from: token.start, to: token.end }, ".cm-context-chip", () => [
      chipCardText(`${token.provider.label} from ${token.provider.pluginName}`),
      chipCardText(chipDescription(token)),
    ]);
  });
}
