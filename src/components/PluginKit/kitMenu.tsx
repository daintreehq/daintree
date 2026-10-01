import type { ComponentType, KeyboardEvent, ReactNode, SyntheticEvent } from "react";
import type { PluginActionMenuItem, PluginDropdownMenuEntry } from "@shared/types/plugin-sdk-react";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { resolvePluginKitIcon } from "./PluginKitIcons";
import { actionMenuRowVisible, useActionMenuRow } from "./PluginKitNativeAgents";
import { field, fn, nonEmpty, str, useKitOwnerAttributes } from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";

/**
 * The host menu primitives a kit menu draws its rows with. `DropdownMenu` and
 * `ContextMenu` share one entry model and one row renderer, and differ only in
 * which Radix family the rows come from.
 */
export interface KitMenuParts {
  Item: ComponentType<{
    children?: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    destructive?: boolean;
    textValue?: string;
    className?: string;
    "aria-keyshortcuts"?: string;
  }>;
  CheckboxItem: ComponentType<{
    children?: ReactNode;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
    textValue?: string;
  }>;
  RadioGroup: ComponentType<{
    children?: ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
    "aria-label"?: string;
  }>;
  RadioItem: ComponentType<{ children?: ReactNode; value: string; disabled?: boolean }>;
  Label: ComponentType<{ children?: ReactNode }>;
  Separator: ComponentType<object>;
  Shortcut: ComponentType<{ shortcut: string | null | undefined }>;
  /**
   * The family's native submenu. Optional so a parts table without one still
   * renders every other row; a `submenu` entry then renders nothing.
   */
  Sub?: ComponentType<{ children?: ReactNode }>;
  SubTrigger?: ComponentType<{
    children?: ReactNode;
    disabled?: boolean;
    textValue?: string;
    className?: string;
  }>;
  SubContent?: ComponentType<{ children?: ReactNode; className?: string }>;
}

export const CONTEXT_MENU_PARTS: KitMenuParts = {
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  Item: ContextMenuItem,
  CheckboxItem: ContextMenuCheckboxItem,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
};

/** Shift+F10 or the Menu key: the keyboard's right-click. */
export function isMenuKey(event: KeyboardEvent): boolean {
  return (
    event.key === "ContextMenu" ||
    (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey)
  );
}

function readRadioItems(items: unknown): { value: string; label: string; disabled: boolean }[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: { value: string; label: string; disabled: boolean }[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const value = nonEmpty(field(item, "value"));
    const label = nonEmpty(field(item, "label"));
    if (value === undefined || label === undefined || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label, disabled: field(item, "disabled") === true });
  }
  return out;
}

function MenuRowIcon({
  Glyph,
  top,
}: {
  Glyph: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  top: boolean;
}) {
  return (
    // `data-menu-icon` gives text-only rows in the same menu the matching gutter.
    // Beside a two-line row it sits on the label's line, not between the two.
    <span
      data-menu-icon=""
      aria-hidden="true"
      className={top ? "mr-2 inline-flex shrink-0 self-start py-px" : "mr-2 inline-flex shrink-0"}
    >
      <Glyph className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}

/**
 * A row's label, and its description as a quieter second line — the shape
 * the browser toolbar's history menu draws its title and address in.
 */
function MenuRowText({ label, description }: { label: string; description?: string }) {
  if (description === undefined) return <>{label}</>;
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate">{label}</span>
      <span className="text-2xs text-text-secondary">{description}</span>
    </span>
  );
}

/** A submenu's panel, in the same layer and with the same owner as the menu it opens from. */
function KitSubmenuContent({
  SubContent,
  children,
}: {
  SubContent: NonNullable<KitMenuParts["SubContent"]>;
  children: ReactNode;
}) {
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  return (
    <SubContent {...owner} className={overlayZ}>
      {children}
    </SubContent>
  );
}

/** A submenu row with a description: the host chevron aligned to the label's line. */
const TWO_LINE_TRIGGER_CLASS = "items-start [&>svg:last-child]:mt-px";

/** An `action` entry: the action's own label, key and availability, read as the menu opens. */
function ActionMenuRow({ parts, entry }: { parts: KitMenuParts; entry: PluginActionMenuItem }) {
  const row = useActionMenuRow(entry);
  if (!row) return null;
  const Glyph = row.icon === undefined ? undefined : resolvePluginKitIcon(row.icon);
  const refused = row.disabled && row.description !== undefined;
  // A refused row keeps the host's 50% on its name, glyph and keys, but its
  // reason is the answer to "why can't I?" and stays readable, in secondary ink.
  const dim = (node: ReactNode) =>
    refused ? <span className="inline-flex shrink-0 self-start opacity-50">{node}</span> : node;
  return (
    <parts.Item
      onSelect={row.onSelect}
      disabled={row.disabled}
      destructive={row.destructive}
      textValue={row.label}
      aria-keyshortcuts={row.shortcut ? comboToAriaKeyshortcuts(row.shortcut, isMac()) : undefined}
      className={refused ? "data-[disabled]:opacity-100" : undefined}
    >
      {Glyph ? dim(<MenuRowIcon Glyph={Glyph} top={row.description !== undefined} />) : null}
      {row.description === undefined ? (
        row.label
      ) : refused ? (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate opacity-50">{row.label}</span>
          <span className="text-2xs text-text-secondary">{row.description}</span>
        </span>
      ) : (
        <MenuRowText label={row.label} description={row.description} />
      )}
      {row.description === undefined ? (
        <parts.Shortcut shortcut={row.shortcut} />
      ) : (
        <span className={cn("ml-auto flex shrink-0 self-start", refused && "opacity-50")}>
          <parts.Shortcut shortcut={row.shortcut} />
        </span>
      )}
    </parts.Item>
  );
}

// A plugin's items can nest (or, by mistake, contain themselves); past this
// depth a submenu renders nothing rather than recursing without end.
const MAX_SUBMENU_DEPTH = 6;

function renderMenuEntry(
  parts: KitMenuParts,
  typed: PluginDropdownMenuEntry,
  index: number,
  depth: number
): ReactNode {
  if (typeof typed !== "object" || typed === null) return null;
  const key = `entry-${index}`;
  switch (typed.type) {
    case "radio-group": {
      const choices = readRadioItems(typed.items);
      if (choices.length === 0) return null;
      const onValueChange = fn(typed.onValueChange);
      const heading = nonEmpty(typed.label);
      return (
        <parts.RadioGroup
          key={key}
          value={str(typed.value) ?? ""}
          onValueChange={(next) => onValueChange?.(next)}
          aria-label={heading}
        >
          {heading ? <parts.Label>{heading}</parts.Label> : null}
          {choices.map((choice) => (
            <parts.RadioItem key={choice.value} value={choice.value} disabled={choice.disabled}>
              {choice.label}
            </parts.RadioItem>
          ))}
        </parts.RadioGroup>
      );
    }
    case "separator":
      return <parts.Separator key={key} />;
    case "label": {
      const label = str(typed.label);
      return label ? <parts.Label key={key}>{label}</parts.Label> : null;
    }
    case "checkbox": {
      const label = str(typed.label);
      const onCheckedChange = fn(typed.onCheckedChange);
      if (!label) return null;
      return (
        <parts.CheckboxItem
          key={key}
          checked={typed.checked === true}
          onCheckedChange={(next) => onCheckedChange?.(next === true)}
          disabled={typed.disabled === true}
          textValue={label}
        >
          <MenuRowText label={label} description={nonEmpty(typed.description)} />
        </parts.CheckboxItem>
      );
    }
    case "submenu": {
      const label = str(typed.label);
      if (!label || !parts.Sub || !parts.SubTrigger || !parts.SubContent) return null;
      if (depth >= MAX_SUBMENU_DEPTH) return null;
      const rows = renderMenuEntries(parts, typed.items, depth + 1).filter((row) => row !== null);
      if (rows.length === 0) return null;
      const Glyph = typed.icon === undefined ? undefined : resolvePluginKitIcon(typed.icon);
      const description = nonEmpty(typed.description);
      return (
        <parts.Sub key={key}>
          <parts.SubTrigger
            disabled={typed.disabled === true}
            textValue={label}
            // Beside two lines the chevron sits on the label's line, not between them.
            className={description === undefined ? undefined : TWO_LINE_TRIGGER_CLASS}
          >
            {Glyph ? <MenuRowIcon Glyph={Glyph} top={description !== undefined} /> : null}
            <MenuRowText label={label} description={description} />
          </parts.SubTrigger>
          <KitSubmenuContent SubContent={parts.SubContent}>{rows}</KitSubmenuContent>
        </parts.Sub>
      );
    }
    case "action":
      return actionMenuRowVisible(typed) ? (
        <ActionMenuRow key={key} parts={parts} entry={typed} />
      ) : null;
    case undefined:
    case "item": {
      const label = str(typed.label);
      const onSelect = fn(typed.onSelect);
      if (!label) return null;
      const Glyph = typed.icon === undefined ? undefined : resolvePluginKitIcon(typed.icon);
      const description = nonEmpty(typed.description);
      return (
        <parts.Item
          key={key}
          onSelect={() => onSelect?.()}
          disabled={typed.disabled === true}
          destructive={typed.destructive === true}
          textValue={label}
        >
          {Glyph ? <MenuRowIcon Glyph={Glyph} top={description !== undefined} /> : null}
          {description === undefined ? (
            label
          ) : (
            <MenuRowText label={label} description={description} />
          )}
          {description === undefined ? (
            <parts.Shortcut shortcut={str(typed.shortcut)} />
          ) : (
            // The key column reads against the label's line, as the icon does.
            <span className="ml-auto flex shrink-0 self-start">
              <parts.Shortcut shortcut={str(typed.shortcut)} />
            </span>
          )}
        </parts.Item>
      );
    }
    default:
      return null;
  }
}

/** A kit menu's `items`, as rows of the given host menu family. */
export function renderMenuEntries(parts: KitMenuParts, items: unknown, depth = 0): ReactNode[] {
  const entries: readonly PluginDropdownMenuEntry[] = Array.isArray(items) ? items : [];
  return entries.map((entry, index) => renderMenuEntry(parts, entry, index, depth));
}

/**
 * Stops a React event reaching the view's handlers without stopping the native
 * event. React's `stopPropagation()` also stops the native event where React
 * listens, which is below `document`, so Radix's document `pointerdown`
 * listener would never see a press inside the menu and never clear the flag
 * that press set: the next click outside would read as inside and be ignored.
 * Shadowing the native method for the call keeps the native event flowing.
 */
export function stopReactPropagation(event: SyntheticEvent) {
  const native = event.nativeEvent;
  const keep = () => {};
  Object.defineProperty(native, "stopPropagation", { value: keep, configurable: true });
  try {
    event.stopPropagation();
  } finally {
    Reflect.deleteProperty(native, "stopPropagation");
  }
}
