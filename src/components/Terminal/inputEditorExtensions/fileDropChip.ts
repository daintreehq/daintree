import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { StateField, StateEffect } from "@codemirror/state";
import { createChipRemoveControl, removeChipRange } from "./base";
import { formatBytes } from "@/lib/formatBytes";
import { chipAriaLabel, chipPendingDeleteField, isChipSelected } from "./chipBackspace";
import { chipCardMeta, chipCardPath, chipHoverTooltip, chipTooltip } from "./chipCard";
import { createTrustedHTML, setTrustedInnerHTML } from "@/lib/trustedTypesPolicy";
import { resolveLocalFileSources } from "@/lib/transferSources";

interface FileDropChipEntry {
  from: number;
  to: number;
  filePath: string;
  fileName: string;
  fileSize?: number;
}

const FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`;

class FileDropChipWidget extends WidgetType {
  constructor(
    readonly filePath: string,
    readonly fileName: string,
    readonly fileSize: number | undefined,
    readonly isSelected: boolean
  ) {
    super();
  }

  eq(other: FileDropChipWidget) {
    return (
      this.filePath === other.filePath &&
      this.fileSize === other.fileSize &&
      this.isSelected === other.isSelected
    );
  }

  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = this.isSelected
      ? "cm-file-drop-chip cm-chip-pending-delete"
      : "cm-file-drop-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", chipAriaLabel(`File: ${this.filePath}`, this.isSelected));
    if (this.fileSize != null) span.setAttribute("aria-description", formatBytes(this.fileSize));

    const icon = document.createElement("span");
    setTrustedInnerHTML(icon, createTrustedHTML(FILE_ICON_SVG));
    icon.style.display = "inline-flex";
    icon.style.alignItems = "center";
    span.appendChild(icon);

    const label = document.createElement("span");
    label.className = "cm-chip-label";
    label.setAttribute("aria-hidden", "true");
    label.textContent = this.fileName;
    span.appendChild(label);

    span.appendChild(
      createChipRemoveControl(() => {
        // Resolve the entry by the widget's document position, not by path —
        // with duplicate chips for the same file, a path lookup removes the
        // first occurrence rather than the chip that was clicked. Half-open
        // containment so an adjacent chip's end boundary can't match first.
        const entries = view.state.field(fileDropChipField, false);
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

export const addFileDropChip = StateEffect.define<FileDropChipEntry>();

export const fileDropChipField = StateField.define<FileDropChipEntry[]>({
  create() {
    return [];
  },
  update(entries, tr) {
    if (tr.docChanged) {
      const surviving: FileDropChipEntry[] = [];
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
      if (effect.is(addFileDropChip)) {
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
          widget: new FileDropChipWidget(e.filePath, e.fileName, e.fileSize, selected),
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

export function createFileDropChipTooltip() {
  return chipHoverTooltip((view, pos) => {
    const entries = view.state.field(fileDropChipField, false);
    if (!entries || entries.length === 0) return null;

    const entry = entries.find((e) => pos >= e.from && pos <= e.to);
    if (!entry) return null;

    return chipTooltip(entry, ".cm-file-drop-chip", () =>
      entry.fileSize != null
        ? [chipCardPath(entry.filePath), chipCardMeta(formatBytes(entry.fileSize))]
        : [chipCardPath(entry.filePath)]
    );
  });
}

export function createFilePasteHandler(
  onFilePaste: (view: EditorView, files: { path: string; name: string; size: number }[]) => void
): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items;
      if (!items) return false;

      // Image items stay with the image paste handler, which saves the
      // clipboard bitmap rather than referencing a file.
      const pasted: File[] = [];
      for (const item of items) {
        if (item.kind === "file" && !item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) pasted.push(file);
        }
      }

      const files = resolveLocalFileSources(pasted).map(({ path, name, size }) => ({
        path,
        name: name.trim() || path.split(/[/\\]/).filter(Boolean).pop() || path,
        size,
      }));

      if (files.length === 0) return false;

      event.preventDefault();
      onFilePaste(view, files);
      return true;
    },
  });
}
