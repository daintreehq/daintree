import { EditorView, Decoration, WidgetType, hoverTooltip } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { StateField, StateEffect } from "@codemirror/state";
import { formatFileSize, removeChipRange } from "./base";
import { chipPendingDeleteField, isChipSelected } from "./chipBackspace";
import { createTrustedHTML, setTrustedInnerHTML } from "@/lib/trustedTypesPolicy";

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
    span.setAttribute("aria-label", `File: ${this.filePath}`);

    const icon = document.createElement("span");
    setTrustedInnerHTML(icon, createTrustedHTML(FILE_ICON_SVG));
    icon.style.display = "inline-flex";
    icon.style.alignItems = "center";
    span.appendChild(icon);

    const label = document.createElement("span");
    label.setAttribute("aria-hidden", "true");
    label.textContent = this.fileName;
    span.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.className = "cm-chip-remove";
    removeBtn.setAttribute("aria-label", "Remove file");
    removeBtn.textContent = "\u00d7";
    removeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const entry = view.state
        .field(fileDropChipField, false)
        ?.find((en) => en.filePath === this.filePath);
      if (entry) removeChipRange(view, entry.from, entry.to);
    });
    span.appendChild(removeBtn);

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
  return hoverTooltip((view, pos) => {
    const entries = view.state.field(fileDropChipField, false);
    if (!entries || entries.length === 0) return null;

    const entry = entries.find((e) => pos >= e.from && pos <= e.to);
    if (!entry) return null;

    return {
      pos: entry.from,
      end: entry.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "px-2 py-1 text-xs";
        dom.style.cssText = `
          background: var(--theme-surface-panel-elevated);
          border-radius: 4px;
          box-shadow: 0 2px 8px var(--theme-scrim-soft);
        `;

        const pathEl = document.createElement("p");
        pathEl.style.cssText =
          "font-size: 10px; color: var(--theme-text-secondary); word-break: break-all; max-width: 300px; font-family: var(--font-mono, monospace);";
        pathEl.textContent = entry.filePath;
        dom.appendChild(pathEl);

        if (entry.fileSize != null) {
          const sizeEl = document.createElement("p");
          sizeEl.style.cssText =
            "font-size: 10px; color: var(--theme-text-muted); margin-top: 2px;";
          sizeEl.textContent = formatFileSize(entry.fileSize);
          dom.appendChild(sizeEl);
        }

        return { dom };
      },
    };
  });
}

export function createFilePasteHandler(
  onFilePaste: (view: EditorView, files: { path: string; name: string; size: number }[]) => void
): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items;
      if (!items) return false;

      const files: { path: string; name: string; size: number }[] = [];
      for (const item of items) {
        if (item.kind === "file" && !item.type.startsWith("image/")) {
          const file = item.getAsFile();
          const filePath = file ? window.electron.webUtils.getPathForFile(file) : undefined;
          if (file && filePath) {
            const name =
              file.name.trim() || filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;
            files.push({ path: filePath, name, size: file.size });
          }
        }
      }

      if (files.length === 0) return false;

      event.preventDefault();
      onFilePaste(view, files);
      return true;
    },
  });
}
