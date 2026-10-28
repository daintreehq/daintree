import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PANE_TOOLBAR_TEXT_BUTTON_CLASS } from "@/components/ui/paneToolbarStyles";
import { TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";

export interface FileEditorPickerOption {
  value: string;
  label: string;
}

/**
 * "Edit with…" (#13809): which editor fills the current mode when more than
 * one matches the file. The pick is remembered per project by the caller.
 * Source stays one click away on the mode control beside it, whatever is
 * picked here.
 */
export function FileEditorPicker({
  label,
  options,
  value,
  onChange,
}: {
  /** `Edit with…` for the Edit mode, `View with…` for Rendered. */
  label: string;
  options: readonly FileEditorPickerOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="file-editor-picker"
          className={PANE_TOOLBAR_TEXT_BUTTON_CLASS}
        >
          {label}
          <ChevronDown className={TOOLBAR_ICON_CLASS} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup aria-label={label} value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
