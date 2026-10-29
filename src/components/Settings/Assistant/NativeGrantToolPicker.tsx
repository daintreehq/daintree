import { useId, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS } from "@shared/config/mcpGrants";
import { SettingsSearchField } from "../SettingsSearchField";
import type { NativeGrantTool } from "./nativeGrantTools";

// Offers only the tools main would accept, by name. Selections survive the
// search narrowing the list, and at the grant's tool limit only unchecked rows
// lock, so the user can still swap one tool for another.
export function NativeGrantToolPicker({
  tools,
  selected,
  onToggle,
  disabled,
}: {
  tools: readonly NativeGrantTool[];
  selected: readonly string[];
  onToggle: (toolId: string, checked: boolean) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const labelId = useId();
  const countId = useId();
  const needle = query.trim().toLowerCase();
  const visible =
    needle === ""
      ? tools
      : tools.filter(
          (tool) =>
            tool.title.toLowerCase().includes(needle) || tool.id.toLowerCase().includes(needle)
        );
  const atLimit = selected.length >= MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS;

  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs text-text-secondary">
        <span id={labelId}>Tools to approve</span>
        <span id={countId} className="tabular-nums">
          {selected.length} of {MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS} chosen
          {atLimit && ". Uncheck one to choose another"}
        </span>
      </div>
      <SettingsSearchField
        value={query}
        onChange={setQuery}
        label="Search tools"
        placeholder="Search tools"
        disabled={disabled}
      />
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={countId}
        className="max-h-48 overflow-y-auto rounded-[var(--radius-sm)] border border-border-default bg-surface-canvas py-1"
      >
        {visible.map((tool) => {
          const checked = selected.includes(tool.id);
          const controlId = `${labelId}-${tool.id}`;
          return (
            <div key={tool.id} className="flex items-center gap-2 px-2 py-1">
              <Checkbox
                id={controlId}
                size="sm"
                checked={checked}
                disabled={disabled || (!checked && atLimit)}
                onCheckedChange={(state) => onToggle(tool.id, state === true)}
              />
              <label
                htmlFor={controlId}
                className="flex min-w-0 flex-1 items-baseline justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate text-text-primary">{tool.title}</span>
                <span className="shrink-0 font-mono text-3xs text-text-secondary">{tool.id}</span>
              </label>
            </div>
          );
        })}
        {visible.length === 0 && (
          <p className="px-2 py-1 text-2xs text-text-secondary">No tools match “{query.trim()}”</p>
        )}
      </div>
    </div>
  );
}
