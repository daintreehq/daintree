import type { RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { Bold, Italic, Code, Heading2, Link, List, ListChecks } from "lucide-react";
import { applyMarkdownFormat, type MarkdownAction } from "./markdownFormatting";

interface MarkdownToolbarProps {
  editorViewRef: RefObject<EditorView | null>;
}

const BUTTONS: { action: MarkdownAction; icon: typeof Bold; label: string }[] = [
  { action: "bold", icon: Bold, label: "Bold" },
  { action: "italic", icon: Italic, label: "Italic" },
  { action: "code", icon: Code, label: "Code" },
];

const BLOCK_BUTTONS: { action: MarkdownAction; icon: typeof Bold; label: string }[] = [
  { action: "heading", icon: Heading2, label: "Heading" },
  { action: "link", icon: Link, label: "Link" },
  { action: "unordered-list", icon: List, label: "List" },
  { action: "task-list", icon: ListChecks, label: "Task list" },
];

export function MarkdownToolbar({ editorViewRef }: MarkdownToolbarProps) {
  const handleAction = (e: React.PointerEvent, action: MarkdownAction) => {
    e.preventDefault();
    const view = editorViewRef.current;
    if (!view) return;
    applyMarkdownFormat(view, action);
  };

  return (
    <div className="flex items-center gap-0.5 px-2 py-1 border-b border-daintree-border/50 shrink-0">
      {BUTTONS.map(({ action, icon: Icon, label }) => (
        <button
          key={action}
          onPointerDown={(e) => handleAction(e, action)}
          className="p-1 rounded-[var(--radius-sm)] text-daintree-text/40 hover:text-daintree-text/70 hover:bg-daintree-text/5 transition-colors"
          aria-label={label}
        >
          <Icon className="w-3.5 h-3.5" />
        </button>
      ))}
      <div className="w-px h-3.5 bg-daintree-border/50 mx-0.5" />
      {BLOCK_BUTTONS.map(({ action, icon: Icon, label }) => (
        <button
          key={action}
          onPointerDown={(e) => handleAction(e, action)}
          className="p-1 rounded-[var(--radius-sm)] text-daintree-text/40 hover:text-daintree-text/70 hover:bg-daintree-text/5 transition-colors"
          aria-label={label}
        >
          <Icon className="w-3.5 h-3.5" />
        </button>
      ))}
    </div>
  );
}
