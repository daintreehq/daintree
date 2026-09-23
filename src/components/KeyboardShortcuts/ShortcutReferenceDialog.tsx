import { useState, useMemo, useEffect, useRef, useId } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { Button } from "@/components/ui/button";
import { useOverlayState } from "@/hooks";
import { KbdChord } from "@/components/ui/Kbd";
import { describeChord } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import { keybindingService } from "../../services/KeybindingService";
import {
  buildShortcutEntries,
  collapseNumberedSeries,
  groupByCategory,
  scopeLabel,
  searchShortcuts,
  sharedScope,
  type ShortcutEntry,
} from "./shortcutReferenceModel";

// The notation legend's example. Any two-step chord would do; this one opens
// the dialog the legend sits in.
const CHORD_EXAMPLE = "Cmd+K Cmd+S";

interface ShortcutReferenceDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

function headingIdFor(prefix: string, category: string): string {
  return `${prefix}-${category
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function spokenBinding(entry: ShortcutEntry, mac: boolean, groupScope: string | null): string {
  const keys =
    entry.alternatives.length === 0
      ? "no shortcut set"
      : entry.alternatives
          .map((alt) => {
            const scope = alt.scope === groupScope ? null : scopeLabel(alt.scope);
            const spoken = describeChord(alt.combo, mac);
            return scope ? `${spoken} (${scope.toLowerCase()})` : spoken;
          })
          .join(", or ");
  return entry.isCustom ? `: ${keys}, customized` : `: ${keys}`;
}

interface ShortcutRowProps {
  entry: ShortcutEntry;
  mac: boolean;
  /** Scope already stated by the group heading, so the row need not repeat it. */
  groupScope: string | null;
  /** Shown beside the name in the ranked search list, where rows lose their heading. */
  categoryLabel?: string;
}

function ShortcutRow({ entry, mac, groupScope, categoryLabel }: ShortcutRowProps) {
  return (
    <div
      role="listitem"
      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5"
    >
      <span className="min-w-0 text-sm leading-5 text-text-primary">
        {entry.description}
        {categoryLabel && <span className="ml-2 text-xs text-text-secondary">{categoryLabel}</span>}
      </span>
      {/* One spoken string for the whole cluster: read chip by chip, "Custom",
          the scope and each "or" would arrive as disconnected fragments. */}
      <span className="sr-only">{spokenBinding(entry, mac, groupScope)}</span>
      <span
        aria-hidden="true"
        className="ml-auto flex min-w-0 max-w-full flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5 text-xs leading-5 text-text-secondary"
      >
        {entry.isCustom && <span>Custom</span>}
        {entry.alternatives.length === 0 ? (
          <span>Not set</span>
        ) : (
          entry.alternatives.map((alt, index) => {
            const scope = alt.scope === groupScope ? null : scopeLabel(alt.scope);
            return (
              <span key={alt.combo} className="inline-flex flex-wrap items-baseline gap-x-2">
                {index > 0 && <span>or</span>}
                <KbdChord
                  shortcut={alt.combo}
                  isMac={mac}
                  density="bare"
                  className="text-text-primary"
                  aria-label=""
                />
                {scope && <span>{scope.toLowerCase()}</span>}
              </span>
            );
          })
        )}
      </span>
    </div>
  );
}

export function ShortcutReferenceDialog({ isOpen, onClose }: ShortcutReferenceDialogProps) {
  useOverlayState(isOpen);
  const [searchQuery, setSearchQuery] = useState("");
  const [bindingsVersion, setBindingsVersion] = useState(0);
  const [wasOpen, setWasOpen] = useState(isOpen);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  const headingPrefix = useId();
  const mac = isMac();

  // Every opening is a fresh lookup. The dialog stays mounted between
  // openings, so without this a reopen lands on the last query — including a
  // no-results one, which makes the reference look empty.
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setSearchQuery("");
  }

  useEffect(() => {
    const unsubscribe = keybindingService.subscribe(() => {
      setBindingsVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  const entries = useMemo(() => {
    void bindingsVersion;
    return buildShortcutEntries(keybindingService.getAllBindingsWithEffectiveCombos(), (id) =>
      keybindingService.hasOverride(id)
    );
  }, [bindingsVersion]);

  const groups = useMemo(() => groupByCategory(entries), [entries]);

  const results = useMemo(() => {
    const ranked = searchShortcuts(entries, searchQuery, mac);
    return ranked ? collapseNumberedSeries(ranked) : null;
  }, [entries, searchQuery, mac]);

  const rowCount = results
    ? results.length
    : groups.reduce((sum, group) => sum + group.entries.length, 0);
  const trimmedQuery = searchQuery.trim();

  // AppDialog is told not to place focus (`initialFocus="none"`), so the search
  // field is the one place focus lands: its own default is the first tabbable,
  // which here is the close button.
  useEffect(() => {
    if (!isOpen) return;
    searchInputRef.current?.focus();
    // The card mounts through AppDialog's presence gate, which can land a frame
    // after this effect; the second attempt covers that frame.
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  const clearSearch = () => {
    setSearchQuery("");
    searchInputRef.current?.focus();
  };

  const openKeyboardSettings = () => {
    onClose();
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", { detail: { tab: "keyboard" } })
    );
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      initialFocus="none"
      // A fixed height, so the card doesn't jump as the result count changes
      // under the user's typing.
      className="h-[80vh]"
    >
      <AppDialog.Header className="flex-col items-stretch gap-4">
        <div className="flex items-center justify-between">
          <AppDialog.Title>Keyboard shortcuts</AppDialog.Title>
          <AppDialog.CloseButton />
        </div>
        <AppPaletteDialog.Input
          inputRef={searchInputRef}
          placeholder="Search by action or key"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search shortcuts"
          aria-controls={resultsId}
        />
      </AppDialog.Header>

      {/* A new query is a new list: keep the best match in view rather than
          holding the offset the user had scrolled to in the old one. */}
      <AppDialog.Body resetScrollKey={trimmedQuery}>
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {trimmedQuery
            ? rowCount === 0
              ? `No shortcuts match "${trimmedQuery}"`
              : `${rowCount} shortcut${rowCount !== 1 ? "s" : ""} found for "${trimmedQuery}"`
            : `${rowCount} shortcut${rowCount !== 1 ? "s" : ""}`}
        </div>

        {results && results.length === 0 ? (
          <div id={resultsId} className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="space-y-1">
              <p className="text-sm text-text-primary">
                No shortcuts match &ldquo;{trimmedQuery}&rdquo;
              </p>
              <p className="text-xs text-text-secondary">
                Try another action name, or keys like{" "}
                <KbdChord shortcut="Cmd+K" isMac={mac} density="bare" />
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={clearSearch}>
              Clear search
            </Button>
          </div>
        ) : results ? (
          <div id={resultsId} role="list" aria-label="Matching shortcuts">
            {results.map((entry) => (
              <ShortcutRow
                key={entry.id}
                entry={entry}
                mac={mac}
                groupScope={null}
                categoryLabel={entry.category}
              />
            ))}
          </div>
        ) : (
          <div id={resultsId} className="space-y-6">
            {groups.map(({ category, entries: groupEntries }) => {
              const headingId = headingIdFor(headingPrefix, category);
              const groupScope = sharedScope(groupEntries);
              const groupScopeLabel = groupScope ? scopeLabel(groupScope) : null;
              return (
                <section key={category} aria-labelledby={headingId}>
                  <h3
                    id={headingId}
                    // Sticky offsets are measured inside the body's padding, so
                    // at `top-0` rows scroll through the band above a stuck
                    // heading. Pinning it into that band and filling it
                    // (-top-6 + pt-6, with -mt-6 to keep the resting layout)
                    // closes the gap.
                    className="sticky -top-6 z-10 -mt-6 flex items-baseline gap-2 border-b border-border-subtle bg-surface-dialog pt-6 pb-1.5 text-sm font-semibold text-text-primary"
                  >
                    {category}
                    {groupScopeLabel && (
                      <span className="text-xs font-normal text-text-secondary">
                        {groupScopeLabel}
                      </span>
                    )}
                  </h3>
                  <div role="list" aria-labelledby={headingId} className="pt-1">
                    {groupEntries.map((entry) => (
                      <ShortcutRow key={entry.id} entry={entry} mac={mac} groupScope={groupScope} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer
        hint={
          // One inline run so it wraps like a sentence at narrow widths
          // instead of the hint slot truncating it.
          <span className="min-w-0">
            <KbdChord shortcut={CHORD_EXAMPLE} isMac={mac} density="bare" /> means press one, then
            the other
          </span>
        }
        secondaryAction={{ label: "Edit shortcuts", onClick: openKeyboardSettings }}
      />
    </AppDialog>
  );
}
