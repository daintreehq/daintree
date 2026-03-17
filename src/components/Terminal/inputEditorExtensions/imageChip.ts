import { EditorView, Decoration, WidgetType, hoverTooltip } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { StateField, StateEffect } from "@codemirror/state";
import { formatChipLabel } from "./base";

interface ImageChipEntry {
  from: number;
  to: number;
  filePath: string;
  thumbnailUrl: string;
}

class ImageChipWidget extends WidgetType {
  constructor(
    readonly filePath: string,
    readonly thumbnailUrl: string
  ) {
    super();
  }

  eq(other: ImageChipWidget) {
    return this.filePath === other.filePath;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-image-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", `Image: ${this.filePath}`);

    const img = document.createElement("img");
    img.src = this.thumbnailUrl;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    span.appendChild(img);

    const label = document.createElement("span");
    label.setAttribute("aria-hidden", "true");
    label.textContent = formatChipLabel(this.filePath);
    span.appendChild(label);

    return span;
  }

  ignoreEvent() {
    return false;
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
    EditorView.decorations.from(f, (entries) => {
      if (entries.length === 0) return Decoration.none;
      const ranges = entries.map((e) =>
        Decoration.replace({ widget: new ImageChipWidget(e.filePath, e.thumbnailUrl) }).range(
          e.from,
          e.to
        )
      );
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

export function createImageChipTooltip() {
  return hoverTooltip((view, pos) => {
    const entries = view.state.field(imageChipField, false);
    if (!entries || entries.length === 0) return null;

    const entry = entries.find((e) => pos >= e.from && pos <= e.to);
    if (!entry) return null;

    return {
      pos: entry.from,
      end: entry.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "px-2 py-2";
        dom.style.cssText = `
          background: var(--theme-surface-panel-elevated);
          border-radius: 6px;
          box-shadow: 0 4px 12px var(--theme-scrim-medium);
        `;

        const img = document.createElement("img");
        img.src = entry.thumbnailUrl;
        img.alt = "Screenshot preview";
        img.style.cssText =
          "max-width: 200px; max-height: 200px; border-radius: 4px; display: block;";
        dom.appendChild(img);

        const pathEl = document.createElement("p");
        pathEl.style.cssText =
          "font-size: 10px; color: var(--theme-text-muted); margin-top: 4px; word-break: break-all; max-width: 200px;";
        pathEl.textContent = entry.filePath;
        dom.appendChild(pathEl);

        return { dom };
      },
    };
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
