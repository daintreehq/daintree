import { createContext, use, useId } from "react";
import type { ReactNode } from "react";
import { CircleAlert, Info, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The settings page grammar: a page is a stack of `SettingsSection`s, a section holds
 * `SettingsGroup`s, and a group is one surface of `SettingsRow`s split by hairlines.
 *
 * The group is the unit the eye scans. Before it, every boolean sat in its own bordered
 * card, so a page of six related switches was six boxes of padding and border to read
 * past, and nothing said which of them belonged together.
 */

interface GroupContextValue {
  /** Nesting depth: 0 for a row directly in a group, 1+ inside `SettingsDependents`. */
  depth: number;
  /** Set by a disabled `SettingsDependents`, so every row under it is really disabled. */
  disabled: boolean;
  /**
   * Id of the reason a disabled `SettingsDependents` shows, so every control under it
   * is described by the explanation it sits beneath, not only by its own text.
   */
  reasonId?: string;
}

const GroupContext = createContext<GroupContextValue | null>(null);

/** Whether the caller sits inside a `SettingsGroup` — adapters render as rows when it does. */
export function useSettingsGroup(): GroupContextValue | null {
  return use(GroupContext);
}

interface SettingsGroupProps {
  children: ReactNode;
  className?: string;
  /** Visible sub-label above the surface, for a section holding more than one group. */
  label?: string;
  id?: string;
}

/**
 * `settings-card` is the themed lift above the dialog body (`--settings-card-bg`, falling
 * back to surface-panel-elevated). Dividers are `border-subtle` so they separate rows
 * without competing with the outer `border-default` edge.
 */
export function SettingsGroup({ children, className, label, id }: SettingsGroupProps) {
  const labelId = useId();
  const surface = (
    <div
      className={cn(
        // checkbox-neutral: a checked option in a settings list is membership, not the
        // region's one accent — native radios and checkboxes paint neutral here.
        "settings-card checkbox-neutral rounded-[var(--radius-lg)] border border-border-default",
        "divide-y divide-border-subtle",
        className
      )}
      {...(label ? { role: "group", "aria-labelledby": labelId } : {})}
      id={label ? undefined : id}
    >
      <GroupContext value={{ depth: 0, disabled: false }}>{children}</GroupContext>
    </div>
  );

  if (!label) return surface;
  return (
    // A 0-min track, so a long unbreakable row label can't widen the group past its column.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2" id={id}>
      <div id={labelId} className="text-xs font-medium text-text-secondary">
        {label}
      </div>
      {surface}
    </div>
  );
}

interface SettingsDependentsProps {
  children: ReactNode;
  /** The parent is off: every row below is disabled, and the reason says why. */
  disabled?: boolean;
  /** Shown above the dependents while they are disabled — next to what it explains. */
  reason?: ReactNode;
}

/**
 * Settings that only mean something while their parent row is on. They sit directly
 * under the parent, indented one step, inside the same group — so the relationship is
 * spatial rather than a sentence somewhere further down the page.
 *
 * `disabled` reaches the controls through context rather than as a dim wrapper: an
 * `opacity-50 pointer-events-none` div looks disabled while every control in it still
 * takes keyboard input.
 */
export function SettingsDependents({
  children,
  disabled = false,
  reason,
}: SettingsDependentsProps) {
  const parent = use(GroupContext);
  const ownReasonId = useId();
  const depth = (parent?.depth ?? 0) + 1;
  const inheritedDisabled = parent?.disabled ?? false;
  const isDisabled = disabled || inheritedDisabled;
  const showsReason = disabled && !!reason;
  const reasonId = showsReason ? ownReasonId : parent?.reasonId;

  return (
    <div className="divide-y divide-border-subtle" data-settings-dependents="">
      {showsReason && (
        <p
          id={ownReasonId}
          className={cn(
            "flex items-start gap-1.5 py-2 pr-4 text-xs text-text-secondary select-text",
            rowInset(depth)
          )}
        >
          <Info className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
          <span>{reason}</span>
        </p>
      )}
      <GroupContext value={{ depth, disabled: isDisabled, reasonId }}>{children}</GroupContext>
    </div>
  );
}

/** 16px row padding plus one 20px step per dependency level. Literal classes so Tailwind sees them. */
const ROW_INSET = ["pl-4", "pl-9", "pl-14"] as const;

function rowInset(depth: number): string {
  return ROW_INSET[Math.min(depth, ROW_INSET.length - 1)]!;
}

/** Row padding for a control that draws its own row anatomy (a checkbox `Field`) inside a group. */
export function settingsRowFrameClass(depth: number): string {
  return cn("py-3 pr-4", rowInset(depth));
}

export interface SettingsRowControlIds {
  labelId: string;
  /**
   * Everything the control's `aria-describedby` should list, already ordered: the
   * error first (a screen reader should reach the problem before the explanation),
   * then the description, then the disabled reason. Undefined when there is none.
   */
  descriptionId: string | undefined;
  disabled: boolean;
}

interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  /**
   * The control. A function receives the ids to wire `aria-labelledby` /
   * `aria-describedby` to the visible label and description, and the effective
   * disabled state (a disabled `SettingsDependents` above counts).
   */
  control?: ReactNode | ((ids: SettingsRowControlIds) => ReactNode);
  /**
   * `inline` puts the control on the row's right rail — switches, selects, short
   * numbers. `stacked` puts it full width under the label — paths, commands, code,
   * lists, anything whose value is wider than a word or two.
   */
  layout?: "inline" | "stacked";
  /** Chips beside the label: scope, lifecycle ("New terminals"), status. */
  accessory?: ReactNode;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  resetTestId?: string;
  disabled?: boolean;
  /** Why the row is disabled. Rendered under the description only while disabled. */
  disabledReason?: ReactNode;
  /** Field-level problem, under the control. */
  error?: ReactNode;
  id?: string;
  className?: string;
  /** Row click target — only switch rows use it, and only outside the control itself. */
  onRowClick?: () => void;
  /** Label text for the reset button when `label` is not a plain string. */
  labelText?: string;
}

export function SettingsRow({
  label,
  description,
  control,
  layout = "inline",
  accessory,
  isModified,
  onReset,
  resetAriaLabel,
  resetTestId,
  disabled: ownDisabled = false,
  disabledReason,
  error,
  id,
  className,
  onRowClick,
  labelText,
}: SettingsRowProps) {
  const group = use(GroupContext);
  const labelId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const reasonId = useId();
  const depth = group?.depth ?? 0;
  const disabled = ownDisabled || (group?.disabled ?? false);
  const showReset = !!isModified && !!onReset && !disabled;
  const resetName =
    resetAriaLabel ??
    `Reset ${labelText ?? (typeof label === "string" ? label : "setting")} to default`;

  const showReason = disabled && !!disabledReason;
  const inheritedReasonId = disabled ? group?.reasonId : undefined;
  const describedBy =
    [
      error ? errorId : null,
      description ? descriptionId : null,
      showReason ? reasonId : null,
      inheritedReasonId ?? null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  const ids: SettingsRowControlIds = { labelId, descriptionId: describedBy, disabled };
  const renderedControl = typeof control === "function" ? control(ids) : control;

  const resetButton = showReset ? (
    <button
      type="button"
      aria-label={resetName}
      data-testid={resetTestId}
      className={cn(
        "p-1 rounded-sm text-text-secondary hover:text-text-primary transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
      )}
      onClick={(e) => {
        e.stopPropagation();
        onReset?.();
      }}
    >
      <RotateCcw className="w-3 h-3" aria-hidden="true" />
    </button>
  ) : null;

  const text = (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span
          id={labelId}
          // The hook a search result lands by when its section has no DOM id.
          data-settings-row-label=""
          // min-w-0 so a label that truncates (an icon + name) shrinks inside its
          // column instead of painting under the controls on the rail.
          className={cn("min-w-0 text-sm font-medium text-text-primary", disabled && "opacity-50")}
        >
          {label}
        </span>
        {accessory}
        {layout === "stacked" && resetButton}
      </div>
      {description && (
        <div
          id={descriptionId}
          className={cn("mt-0.5 text-xs text-text-secondary select-text", disabled && "opacity-50")}
        >
          {description}
        </div>
      )}
      {showReason && (
        <p
          id={reasonId}
          className="mt-1 flex items-start gap-1.5 text-xs text-text-secondary select-text"
        >
          <Info className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
          <span>{disabledReason}</span>
        </p>
      )}
    </div>
  );

  const handleRowClick = onRowClick
    ? (e: React.MouseEvent) => {
        const target = e.target as HTMLElement;
        if (disabled) return;
        if (target.closest("button, a, input, select, textarea, [role='switch']")) return;
        onRowClick();
      }
    : undefined;

  return (
    <div
      id={id}
      data-settings-row={layout}
      className={cn(
        "settings-row relative py-3 pr-4 scroll-mt-6",
        rowInset(depth),
        layout === "inline" ? "flex flex-wrap items-center gap-x-4 gap-y-1" : "grid gap-2.5",
        onRowClick && !disabled && "cursor-pointer",
        className
      )}
      onClick={handleRowClick}
    >
      {isModified && (
        <span
          className="status-mark absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-full bg-state-modified"
          aria-hidden="true"
        />
      )}
      {text}
      {layout === "inline" ? (
        <div className="flex items-center gap-2 shrink-0">
          {resetButton}
          {renderedControl}
        </div>
      ) : (
        renderedControl && <div className="min-w-0">{renderedControl}</div>
      )}
      {error && (
        // The glyph carries the severity; the words stay neutral, because
        // severity-coloured text falls under 4.5:1 on most themes.
        <p
          id={errorId}
          className={cn(
            "flex items-start gap-1.5 text-xs text-text-primary",
            layout === "inline" && "basis-full"
          )}
        >
          <CircleAlert
            className="w-3.5 h-3.5 mt-px shrink-0 text-status-error"
            aria-hidden="true"
          />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

interface SettingsActionsProps {
  children: ReactNode;
  /** Status beside the actions — "Saved", a test result — on the left of the row. */
  status?: ReactNode;
}

/**
 * The last row of a group whose edits need an explicit commit (Save, Test, Discard).
 * Actions end on the same right rail as every control above them; content-width,
 * never full-width, and the primary one is the neutral `contrast` button.
 */
export function SettingsActions({ children, status }: SettingsActionsProps) {
  const group = use(GroupContext);
  return (
    <div
      className={cn("flex items-center gap-3 py-2.5 pr-4 min-h-12", rowInset(group?.depth ?? 0))}
    >
      <div className="min-w-0 flex-1 text-xs text-text-secondary" aria-live="polite">
        {status}
      </div>
      <div className="flex items-center gap-2 shrink-0">{children}</div>
    </div>
  );
}

interface SettingsEmptyRowProps {
  /** What to add, phrased as the next step — "Add a variable to set it in every terminal". */
  children: ReactNode;
  /** The add action, content-width, on the rail. */
  action?: ReactNode;
}

/**
 * An empty collection inside its group: one line naming the next step and the action
 * that takes it. Not a dashed box, not a centred illustration, not a second button
 * below it — the empty list keeps the shape the full one will have.
 */
export function SettingsEmptyRow({ children, action }: SettingsEmptyRowProps) {
  const group = use(GroupContext);
  return (
    <div
      className={cn("flex items-center gap-4 py-3 pr-4", rowInset(group?.depth ?? 0))}
      data-settings-empty=""
    >
      <p className="min-w-0 flex-1 text-sm text-text-secondary">{children}</p>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Right-rail widths so a four-digit number doesn't take the width of a file path. */
export const SETTINGS_CONTROL_WIDTH = {
  number: "w-24",
  /** A number with a unit inside the field: room for five digits, the unit and the stepper. */
  numberWithUnit: "w-32",
  select: "w-52",
  wide: "w-72",
} as const;
