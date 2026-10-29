import { useId, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CALLOUT_ICON_TONE } from "@/components/ui/Callout";
import { deviceOwnerPhrase } from "@/hooks/useSettingsOwner";
import { pluralNoun, pluralize } from "@/lib/pluralize";
import { SEVERITY_GLYPH, type StatusSeverity } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import {
  CONFIG_BUNDLE_SECTION_LABELS,
  type ConfigBundlePreviewChange,
} from "@shared/types/configBundle";
import type { HostId } from "@shared/types/remoteHosts";
import { SettingsDependents, SettingsRow } from "../SettingsGroup";
import { requestHostUpdate } from "./hostUpdateRequests";
import {
  changePhrase,
  isQuiet,
  listPhrase,
  type CategoryPreview,
  type CategoryReport,
} from "./settingsCopyPreview";

/**
 * Changes a category shows before "Show all": overwrites first, so the ones
 * that replace something are what a long category leads with.
 */
const CHANGES_SHOWN = 3;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A line of outcome words led by its severity glyph: `InlineError`'s anatomy
 * for the other severities, so an applied, a partial and a failed copy differ
 * in shape as well as in words. The words stay on the neutral ramp.
 */
export function StatusLine({
  severity,
  children,
  className,
}: {
  severity: StatusSeverity;
  children: ReactNode;
  className?: string;
}) {
  const Glyph = SEVERITY_GLYPH[severity];
  return (
    <span className={cn("flex items-start gap-1.5 text-xs text-text-primary", className)}>
      <Glyph
        className={cn("w-3.5 h-3.5 mt-px shrink-0", CALLOUT_ICON_TONE[severity])}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">{children}</span>
    </span>
  );
}

/** The incoming value emphasised, the one it replaces before it. */
function ChangeDetail({ change }: { change: ConfigBundlePreviewChange }) {
  const value =
    change.kind === "update" && change.from !== undefined && change.to !== undefined ? (
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
        <span className="break-all">{change.from}</span>
        <ArrowRight className="w-3 h-3 shrink-0 self-center" aria-hidden="true" />
        <span className="sr-only">becomes</span>
        <span className="break-all text-text-primary">{change.to}</span>
      </span>
    ) : change.kind === "update" && change.renamedTo ? (
      <span>
        Renamed to <span className="text-text-primary">{change.renamedTo}</span>
      </span>
    ) : change.kind === "add" && change.to !== undefined ? (
      <span className="break-all text-text-primary">{change.to}</span>
    ) : null;
  if (!value && !change.note) return null;
  return (
    <>
      {value && <span className="block">{value}</span>}
      {change.note && (
        <span className="mt-0.5 flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
          <span>{change.note}</span>
        </span>
      )}
    </>
  );
}

const KIND_BADGE = {
  update: { label: "Overwrites", tone: "outline" },
  add: { label: "New", tone: "neutral" },
} as const;

interface CategoryPreviewRowsProps {
  item: CategoryPreview;
  hostName: string;
}

/**
 * One category of a preview: a summary row (what it overwrites and adds, what
 * won't copy, whether the host is too old for it), then its settings under it.
 * A long category shows its first few changes and discloses the rest, so forty
 * shortcuts don't stand between the decision and the Copy button. What won't
 * copy is always shown: it is the part a person has to act on.
 */
export function CategoryPreviewRows({ item, hostName }: CategoryPreviewRowsProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const { category, changes, skipped, withheld, unknown } = item;
  const update = changes.filter((change) => change.kind === "update").length;
  const add = changes.length - update;
  const allUnknown = unknown.length === category.sections.length;
  const collapsible = changes.length > CHANGES_SHOWN;
  const shown = collapsible && !expanded ? changes.slice(0, CHANGES_SHOWN) : changes;
  const notCopied = skipped.length + withheld.length;

  const summary = allUnknown ? (
    <StatusLine severity="warning">
      {`Won't copy: Daintree on ${hostName} doesn't know these settings yet`}
    </StatusLine>
  ) : (
    sentence(
      [
        changePhrase(update, add),
        notCopied > 0 ? `${notCopied} won't copy` : null,
        unknown.length > 0
          ? `${unknown.length} ${unknown.length === 1 ? "needs" : "need"} a newer Daintree`
          : null,
      ]
        .filter((part): part is string => !!part)
        .join(", ")
    )
  );

  return (
    <>
      <SettingsRow
        label={category.label}
        description={summary}
        control={
          collapsible && !allUnknown ? (
            <DisclosureButton
              expanded={expanded}
              controls={listId}
              onToggle={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show fewer" : `Show all ${changes.length}`}
            </DisclosureButton>
          ) : undefined
        }
      />
      {!allUnknown && (
        <div id={listId}>
          <SettingsDependents>
            {shown.map((change) => (
              <SettingsRow
                key={change.id}
                label={change.label}
                accessory={
                  <Badge size="xs" tone={KIND_BADGE[change.kind].tone}>
                    {KIND_BADGE[change.kind].label}
                  </Badge>
                }
                description={<ChangeDetail change={change} />}
              />
            ))}
            {skipped.map((skip) => (
              <SettingsRow
                key={skip.id}
                label={skip.label}
                description={
                  <StatusLine severity="warning">Won&apos;t copy: {skip.reason}</StatusLine>
                }
              />
            ))}
            {withheld.length > 0 && (
              <SettingsRow
                label={withheld.join(", ")}
                description={
                  <StatusLine severity="info">
                    {`Stays on ${deviceOwnerPhrase()}: ${pluralNoun(withheld.length, "it looks like a secret", "they look like secrets")}`}
                  </StatusLine>
                }
              />
            )}
            {unknown.length > 0 && (
              <SettingsRow
                label={listPhrase(unknown.map((id) => CONFIG_BUNDLE_SECTION_LABELS[id]))}
                description={
                  <StatusLine severity="warning">
                    {`Won't copy: Daintree on ${hostName} doesn't know ${pluralNoun(unknown.length, "this", "these")} yet`}
                  </StatusLine>
                }
              />
            )}
          </SettingsDependents>
        </div>
      )}
    </>
  );
}

/**
 * The categories with nothing to review, as one row each kind rather than a
 * group per category saying the same sentence.
 */
export function QuietCategoryRows({
  items,
  hostName,
}: {
  items: readonly CategoryPreview[];
  hostName: string;
}) {
  const quiet = items.filter(isQuiet);
  const same = quiet.filter((item) => item.unchanged > 0).map((item) => item.category.label);
  const empty = quiet.filter((item) => item.unchanged === 0).map((item) => item.category.label);
  return (
    <>
      {same.length > 0 && (
        <SettingsRow label={`Already the same on ${hostName}`} description={listPhrase(same)} />
      )}
      {empty.length > 0 && (
        <SettingsRow
          label={`Nothing set on ${deviceOwnerPhrase()} to copy`}
          description={listPhrase(empty)}
        />
      )}
    </>
  );
}

/** The categories that copied cleanly, as one row: the healthy remainder of a result. */
export function CopiedCategoriesRow({ items }: { items: readonly CategoryReport[] }) {
  const clean = items.filter((item) => !needsReport(item));
  if (clean.length === 0) return null;
  const applied = clean.reduce((sum, item) => sum + item.totals.applied, 0);
  return (
    <SettingsRow
      label={clean.length === items.length ? "Every category copied" : "Copied in full"}
      description={
        <>
          <StatusLine severity="success">{pluralize(applied, "setting")} copied</StatusLine>
          <span className="mt-0.5 block">
            {listPhrase(
              clean.map((item) =>
                item.totals.applied > 0
                  ? `${item.category.label} (${item.totals.applied})`
                  : item.category.label
              )
            )}
          </span>
        </>
      }
    />
  );
}

/** Whether a category's result has anything to say beyond its count. */
export function needsReport(item: CategoryReport): boolean {
  return item.failed.length + item.skipped.length + item.unknown.length + item.withheld.length > 0;
}

/** One category of a copy's result: its counts, then each setting that didn't copy and why. */
export function CategoryReportRows({ item, hostName }: { item: CategoryReport; hostName: string }) {
  const { category, totals, failed, skipped, unknown, withheld } = item;
  const counts = [
    totals.applied > 0 ? `${totals.applied} copied` : null,
    totals.failed > 0 ? `${totals.failed} failed` : null,
    totals.skipped > 0 ? `${totals.skipped} skipped` : null,
    totals.unchanged > 0 ? `${totals.unchanged} already the same` : null,
  ].filter((part): part is string => part !== null);
  return (
    <>
      <SettingsRow
        label={category.label}
        description={
          totals.failed > 0 || totals.skipped > 0 ? (
            <StatusLine severity={totals.applied === 0 && totals.failed > 0 ? "error" : "warning"}>
              {counts.join(", ")}
            </StatusLine>
          ) : totals.applied > 0 ? (
            <StatusLine severity="success">{counts.join(", ")}</StatusLine>
          ) : (
            counts.join(", ") || "Nothing to copy"
          )
        }
      />
      {failed.length + skipped.length + unknown.length + withheld.length > 0 && (
        <SettingsDependents>
          {failed.map((leaf) => (
            <SettingsRow
              key={leaf.id}
              label={leaf.label}
              error={`Failed: ${leaf.reason ?? "it couldn't be written"}`}
            />
          ))}
          {skipped.map((leaf) => (
            <SettingsRow
              key={leaf.id}
              label={leaf.label}
              description={
                <StatusLine severity="warning">
                  {leaf.reason ? `Skipped: ${leaf.reason}` : "Skipped"}
                </StatusLine>
              }
            />
          ))}
          {unknown.length > 0 && (
            <SettingsRow
              label={listPhrase(unknown.map((id) => CONFIG_BUNDLE_SECTION_LABELS[id]))}
              description={
                <StatusLine severity="warning">
                  {`Not copied: Daintree on ${hostName} doesn't know ${pluralNoun(unknown.length, "this", "these")} yet`}
                </StatusLine>
              }
            />
          )}
          {withheld.length > 0 && (
            <SettingsRow
              label={withheld.join(", ")}
              description={
                <StatusLine severity="info">
                  {`Stayed on ${deviceOwnerPhrase()}: ${pluralNoun(withheld.length, "it looks like a secret", "they look like secrets")}`}
                </StatusLine>
              }
            />
          )}
        </SettingsDependents>
      )}
    </>
  );
}

/** A row's show/hide control: a real button with `aria-expanded`, and a chevron that turns with it. */
export function DisclosureButton({
  expanded,
  controls,
  onToggle,
  label,
  children,
}: {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  /** An accessible name naming what it opens, when the visible words alone don't. */
  label?: string;
  children: ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={label}
      onClick={onToggle}
    >
      {children}
      <ChevronDown
        aria-hidden="true"
        className={cn("transition-transform duration-150 ease-out", expanded && "rotate-180")}
      />
    </Button>
  );
}

/**
 * The chosen categories a copy's report doesn't mention, by why: the host was
 * too old for them, they were already the same, or this Mac had nothing set.
 */
export function UncopiedCategoryRows({
  items,
  hostName,
}: {
  items: readonly CategoryPreview[];
  hostName: string;
}) {
  const tooOld = items.filter((item) => item.unknown.length > 0).map((item) => item.category.label);
  return (
    <>
      {tooOld.length > 0 && (
        <SettingsRow
          label={listPhrase(tooOld)}
          description={
            <StatusLine severity="warning">
              {`Not copied: Daintree on ${hostName} doesn't know ${pluralNoun(tooOld.length, "this", "these")} yet`}
            </StatusLine>
          }
        />
      )}
      <QuietCategoryRows
        items={items.filter((item) => item.unknown.length === 0)}
        hostName={hostName}
      />
    </>
  );
}

/** Opens the host's own update flow, for a preview that found Daintree there too old. */
export function UpdateDaintreeButton({ hostId, hostName }: { hostId: HostId; hostName: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => requestHostUpdate(hostId)}
      aria-label={`Update Daintree on ${hostName}`}
    >
      Update Daintree
    </Button>
  );
}

/** Names that stay readable however many there are: the first few, then a counted disclosure. */
export function NameList({ names, shown = 6 }: { names: readonly string[]; shown?: number }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (names.length <= shown) return <span>{listPhrase(names)}</span>;
  return (
    <span id={listId}>
      {expanded ? listPhrase(names) : `${names.slice(0, shown).join(", ")}, `}{" "}
      <Button
        variant="link"
        size="inline"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Show fewer" : `and ${pluralize(names.length - shown, "more", "more")}`}
      </Button>
    </span>
  );
}
