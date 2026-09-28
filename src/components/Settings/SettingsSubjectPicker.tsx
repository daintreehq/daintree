import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PopoverSearchField } from "@/components/ui/PopoverSearchField";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";

interface SettingsSubjectPickerProps<T extends { id: string }> {
  /**
   * Prefix for the DOM hooks tests and E2E helpers use: `{prefix}-trigger` (test id),
   * `{prefix}-list` and `{prefix}-item-{id}`.
   */
  idPrefix: string;
  /** The fixed first entry — the page for the whole area rather than one subject. */
  overview: T;
  entries: readonly T[];
  /** Whether an entry answers the (trimmed, lower-cased) filter query. */
  matches: (entry: T, query: string) => boolean;
  /** Band label for an entry, when the list is grouped. A band opens where it changes. */
  groupOf?: (entry: T) => string | undefined;
  activeId: string;
  onChange: (id: string) => void;
  /** The trigger's content: identity mark, name and status for the page being shown. */
  current: ReactNode;
  /**
   * The verb on the trigger's right segment ("Switch agent"). The name alone read
   * as a page heading, so nothing at rest said the page's subject could change.
   */
  switchLabel: string;
  /** A row's content: identity mark, name and status. The current-page check is added here. */
  renderRow: (item: T) => ReactNode;
  listLabel: string;
  filterLabel: string;
  placeholder: string;
  noMatches: (query: string) => ReactNode;
}

/**
 * The switcher at the top of a settings page that chooses what the rest of the
 * page is about — CLI agents, Code forge, a project's Plugins.
 *
 * It is navigation, so the trigger reads as the page's subject with a switch
 * affordance (name at heading weight, `ChevronsUpDown`, a surface only on hover or
 * while open) rather than a bordered field that looks like one more setting. The
 * list is a fixed-width panel under it that unrolls downward (`motion="drop"`).
 *
 * Two marks, one meaning each, from the palette family (`paletteRowStyles`):
 * `aria-current` + a check is the page being shown; `aria-selected` + the raised
 * fill and rail is the row Enter acts on. A pointer opening places no cursor — the
 * current page shows only its check until the pointer or an arrow key moves one —
 * so the list never opens with a highlight the user did not put there, and never
 * piles the fill, rail and check onto the row they came from. A keyboard opening
 * lands the cursor on the current page, so Enter straight away is a no-op.
 *
 * This used to be three sibling components that had each drifted: one reopened on
 * whatever row was last hovered, one marked the current page with weight alone, and
 * one let Enter on a failed search jump to the overview.
 */
export function SettingsSubjectPicker<T extends { id: string }>({
  idPrefix,
  overview,
  entries,
  matches,
  groupOf,
  activeId,
  onChange,
  current,
  switchLabel,
  renderRow,
  listLabel,
  filterLabel,
  placeholder,
  noMatches,
}: SettingsSubjectPickerProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(-1);
  const pointerOpenRef = useRef(false);

  const q = query.trim().toLowerCase();
  const items: T[] = [overview, ...entries.filter((entry) => !q || matches(entry, q))];
  // The overview stays listed as a destination but is never a search result, so a
  // query with nothing matching leaves nothing for Enter to pick.
  const noMatch = q.length > 0 && items.length === 1;
  const currentIndex = items.findIndex((item) => item.id === activeId);

  const itemId = (id: string) => `${idPrefix}-item-${id}`;

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setQuery("");
      const index = [overview, ...entries].findIndex((item) => item.id === activeId);
      setCursor(pointerOpenRef.current ? -1 : Math.max(0, index));
    }
    pointerOpenRef.current = false;
    setOpen(next);
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    const nextQ = value.trim().toLowerCase();
    if (nextQ) {
      setCursor(entries.some((entry) => matches(entry, nextQ)) ? 1 : -1);
    } else {
      setCursor([overview, ...entries].findIndex((item) => item.id === activeId));
    }
  };

  // The row to keep in view: the cursor once there is one, else the current page, so
  // reopening on a subject late in a long list shows its check without scrolling.
  const anchorDomId = items[cursor >= 0 ? cursor : currentIndex]
    ? itemId(items[cursor >= 0 ? cursor : currentIndex]!.id)
    : null;
  useEffect(() => {
    if (!open || !anchorDomId) return;
    const frame = requestAnimationFrame(() =>
      document.getElementById(anchorDomId)?.scrollIntoView({ block: "nearest" })
    );
    return () => cancelAnimationFrame(frame);
  }, [anchorDomId, open]);

  const select = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        if (noMatch) return;
        const step = e.key === "ArrowDown" ? 1 : -1;
        setCursor((prev) => {
          // The first arrow after a pointer opening starts from the page being shown.
          if (prev < 0) return currentIndex >= 0 ? currentIndex : step > 0 ? 0 : items.length - 1;
          return Math.min(Math.max(prev + step, 0), items.length - 1);
        });
        break;
      }
      case "Enter": {
        const item = cursor >= 0 ? items[cursor] : undefined;
        if (item) {
          e.preventDefault();
          select(item.id);
        }
        break;
      }
    }
  };

  const cursorItem = cursor >= 0 ? items[cursor] : undefined;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          data-testid={`${idPrefix}-trigger`}
          onPointerDown={() => {
            pointerOpenRef.current = true;
          }}
          onKeyDown={() => {
            pointerOpenRef.current = false;
          }}
          className={cn(
            // A resting surface and edge, content-width: it has to read as a control
            // before it is hovered (a bare name looked like the page's heading), but
            // not as a full-width field holding one more setting.
            "group/switcher inline-flex h-10 max-w-full min-w-0 items-stretch",
            "rounded-[var(--radius-md)] border border-border-default bg-overlay-subtle text-text-primary",
            "transition-colors duration-150 ease-out",
            "hover:border-border-strong hover:bg-overlay-soft",
            "data-[state=open]:border-border-strong data-[state=open]:bg-overlay-soft",
            "outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
          )}
        >
          <span className="flex min-w-0 items-center gap-2 pl-3 pr-3">{current}</span>
          {/* The verb, in its own segment, so "this changes what the page is about"
              is said in words rather than left to a chevron. */}
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-l border-border-default px-3",
              "text-xs font-medium text-text-secondary",
              "transition-colors duration-150 ease-out",
              "group-hover/switcher:text-text-primary group-data-[state=open]/switcher:text-text-primary"
            )}
          >
            {switchLabel}
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        motion="drop"
        className="p-0 w-96 max-w-[var(--radix-popover-content-available-width)]"
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <PopoverSearchField
          autoFocus
          placeholder={placeholder}
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-label={filterLabel}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={`${idPrefix}-list`}
          aria-activedescendant={cursorItem ? itemId(cursorItem.id) : undefined}
        />
        <div
          role="listbox"
          id={`${idPrefix}-list`}
          aria-label={listLabel}
          // Tall enough for a grouped list in a settings dialog: at 240px the second
          // band started below the fold with nothing saying it was there.
          className="overflow-y-auto max-h-[min(28rem,60vh)] p-1"
        >
          {items.map((item, index) => {
            const isCursor = index === cursor;
            const isCurrent = item.id === activeId;
            const group = index > 0 ? groupOf?.(item) : undefined;
            const previousGroup = index > 1 ? groupOf?.(items[index - 1]!) : undefined;
            const bandLabel = group && group !== previousGroup ? group : null;

            return (
              <div key={item.id}>
                {bandLabel && (
                  // A disabled option rather than a role="group" label — group
                  // labels drop under Chromium + VoiceOver (LESSON #9006).
                  <div
                    role="option"
                    aria-disabled="true"
                    aria-selected="false"
                    aria-label={bandLabel}
                    className={cn("px-2 pt-2.5 pb-1", PALETTE_SECTION_LABEL_CLASS)}
                  >
                    {bandLabel}
                  </div>
                )}
                <div
                  id={itemId(item.id)}
                  role="option"
                  aria-selected={isCursor}
                  aria-current={isCurrent ? "page" : undefined}
                  onClick={() => select(item.id)}
                  // Move, not enter: a list opening under a resting pointer must not
                  // light the row beneath it before the pointer does anything.
                  onPointerMove={() => {
                    if (!isCursor) setCursor(index);
                  }}
                  className={cn(
                    PALETTE_ROW_CLASS,
                    "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer text-sm text-text-primary"
                  )}
                >
                  {renderRow(item)}
                  {/* Reserved on every row so status words keep one right edge. */}
                  <Check
                    className={cn("h-3.5 w-3.5 shrink-0", !isCurrent && "invisible")}
                    aria-hidden="true"
                  />
                </div>
              </div>
            );
          })}
          {noMatch && (
            <div role="status" className="px-2 py-3 text-xs text-text-secondary">
              {noMatches(query.trim())}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
