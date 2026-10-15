import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { StateField, StateEffect } from "@codemirror/state";
import { createChipRemoveControl, formatChipLabel, removeChipRange } from "./base";
import { chipAriaLabel, chipPendingDeleteField, isChipSelected } from "./chipBackspace";
import { chipCardPath, chipHoverTooltip, chipTooltip } from "./chipCard";

interface ImageChipEntry {
  from: number;
  to: number;
  filePath: string;
  thumbnailUrl: string;
}

class ImageChipWidget extends WidgetType {
  constructor(
    readonly filePath: string,
    readonly thumbnailUrl: string,
    readonly isSelected: boolean
  ) {
    super();
  }

  eq(other: ImageChipWidget) {
    return this.filePath === other.filePath && this.isSelected === other.isSelected;
  }

  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = this.isSelected ? "cm-image-chip cm-chip-pending-delete" : "cm-image-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", chipAriaLabel(`Image: ${this.filePath}`, this.isSelected));

    const img = document.createElement("img");
    img.src = this.thumbnailUrl;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    span.appendChild(img);

    const label = document.createElement("span");
    label.className = "cm-chip-label";
    label.setAttribute("aria-hidden", "true");
    label.textContent = formatChipLabel(this.filePath);
    span.appendChild(label);

    span.appendChild(
      createChipRemoveControl(() => {
        // Position-based lookup so duplicate chips for the same image remove
        // the clicked chip, not the first occurrence (mirrors fileDropChip).
        const entries = view.state.field(imageChipField, false);
        if (!entries) return;
        let pos = -1;
        try {
          pos = view.posAtDOM(span);
        } catch {
          // Widget DOM already detached — fall through to the path match.
        }
        const byPos = pos >= 0 ? entries.find((en) => pos >= en.from && pos < en.to) : undefined;
        const entry = byPos ?? entries.find((en) => en.filePath === this.filePath);
        if (entry) removeChipRange(view, entry.from, entry.to);
      })
    );

    return span;
  }

  ignoreEvent(event: Event) {
    const target = event.target as HTMLElement;
    return !!target.closest?.(".cm-chip-remove");
  }
}

export const addImageChip = StateEffect.define<ImageChipEntry>();

export const imageChipField = StateField.define<ImageChipEntry[]>({
  create() {
    return [];
  },
  update(entries, tr) {
    if (tr.docChanged) {
      const surviving: ImageChipEntry[] = [];
      for (const e of entries) {
        let edited = false;
        tr.changes.iterChangedRanges((fromA, toA) => {
          if (fromA < e.to && toA > e.from) edited = true;
        });
        if (edited) continue;
        const from = tr.changes.mapPos(e.from, 1);
        const to = tr.changes.mapPos(e.to, -1);
        if (from < to) surviving.push({ ...e, from, to });
      }
      entries = surviving;
    }
    for (const effect of tr.effects) {
      if (effect.is(addImageChip)) {
        entries = [...entries, effect.value];
      }
    }
    return entries;
  },
  provide: (f) => [
    EditorView.decorations.of((view) => {
      const entries = view.state.field(f, false);
      if (!entries || entries.length === 0) return Decoration.none;
      const pending = view.state.field(chipPendingDeleteField, false) ?? null;
      const ranges = entries.map((e) => {
        const selected = isChipSelected(pending, e.from, e.to);
        return Decoration.replace({
          widget: new ImageChipWidget(e.filePath, e.thumbnailUrl, selected),
        }).range(e.from, e.to);
      });
      return Decoration.set(ranges, true);
    }),
    EditorView.atomicRanges.of((view) => {
      const entries = view.state.field(f, false);
      if (!entries || entries.length === 0) return Decoration.none;
      const ranges = entries.map((e) => Decoration.mark({}).range(e.from, e.to));
      return Decoration.set(ranges, true);
    }),
  ],
});

/**
 * Paths of the image chips still in `view`'s document, in document order
 * (#12792). A chip whose range no longer spells its path — an edit that
 * slipped past the field's own pruning — is left out, so what is sent as an
 * attachment is always something the text also says.
 */
export function readImageChipPaths(view: EditorView | null | undefined): string[] {
  if (!view) return [];
  const entries = view.state.field(imageChipField, false);
  if (!entries || entries.length === 0) return [];
  return [...entries]
    .sort((a, b) => a.from - b.from)
    .filter((entry) => view.state.doc.sliceString(entry.from, entry.to) === entry.filePath)
    .map((entry) => entry.filePath);
}

export function createImageChipTooltip() {
  return chipHoverTooltip((view, pos) => {
    const entries = view.state.field(imageChipField, false);
    if (!entries || entries.length === 0) return null;

    const entry = entries.find((e) => pos >= e.from && pos <= e.to);
    if (!entry) return null;

    return chipTooltip(entry, ".cm-image-chip", () => {
      const img = document.createElement("img");
      img.src = entry.thumbnailUrl;
      img.alt = "Screenshot preview";
      img.className = "block max-h-[180px] max-w-[240px] rounded-[var(--radius-sm)] object-contain";
      const path = chipCardPath(entry.filePath);
      path.classList.add("mt-1.5");
      return [img, path];
    });
  });
}

export function createImagePasteHandler(onImagePaste: (view: EditorView) => void): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items;
      if (!items) return false;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          event.preventDefault();
          onImagePaste(view);
          return true;
        }
      }
      return false;
    },
  });
}
