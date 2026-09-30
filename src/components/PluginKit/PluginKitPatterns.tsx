import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type {
  PluginFormFieldControlProps,
  PluginFormFieldGroupProps,
  PluginFormFieldProps,
  PluginListRowProps,
  PluginPaneHeaderProps,
  PluginPaneStateProps,
  PluginProgressBarProps,
  PluginSettingsActionsProps,
  PluginSettingsGroupProps,
  PluginSettingsRowControlIds,
  PluginSettingsRowProps,
  PluginSettingsSectionProps,
  PluginSeverity,
  PluginSeverityIconProps,
  PluginSwitchProps,
  PluginTabsProps,
  PluginToolbarButtonProps,
  PluginToolbarProps,
} from "@shared/types/plugin-sdk-react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { SettingsActions, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CALLOUT_ICON } from "@/components/ui/Callout";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  InlineError,
  useFieldControl,
} from "@/components/ui/field";
import {
  LIST_DETAIL_ROW_CLASS,
  PALETTE_ROW_CLASS,
  PALETTE_ROW_FOCUS_CLASS,
} from "@/components/ui/paletteRowStyles";
import { PaneLoadingState } from "@/components/ui/PaneLoadingState";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
  PANE_TOOLBAR_TEXT_BUTTON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { PaneState, PaneStateActions } from "@/components/ui/PaneState";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { documentTabClassName, revealTabInStrip } from "@/components/ui/document-tab";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import { SEVERITY_VISUAL } from "@/lib/statusSeverity";
import { formatCompactCount } from "@/lib/formatCount";
import { cn } from "@/lib/utils";
import { renderIconSource, resolvePluginKitIcon } from "./PluginKitIcons";
import { useKitOverlayZClass } from "./kitScope";
import {
  content,
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickDomProps,
  pickRootProps,
  PluginStyleScope,
  positive,
  str,
} from "./kitProps";

/** A kit icon source at a fixed size: names resolve to host glyphs, elements get sized. */
export function sizedIcon(source: unknown, className: string): ReactNode {
  if (typeof source === "string") {
    const Glyph = resolvePluginKitIcon(source);
    return Glyph ? <Glyph className={className} aria-hidden="true" /> : null;
  }
  const element = renderIconSource(source);
  return element ? (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 [&>svg]:size-full", className)}>
      {element}
    </span>
  ) : null;
}

function KitPaneHeader({
  title,
  icon,
  subtitle,
  actions,
  className,
  ...rest
}: PluginPaneHeaderProps) {
  const trailing = content(actions);
  return (
    <SurfaceHeader
      {...pickRootProps(rest)}
      density="compact"
      className={cn("gap-2", str(className))}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {sizedIcon(icon, "h-4 w-4 text-text-secondary")}
        <h2 className="min-w-0 truncate text-xs font-medium text-text-primary">{node(title)}</h2>
        {hasContent(subtitle) ? (
          <span className="min-w-0 truncate text-xs text-text-secondary">{node(subtitle)}</span>
        ) : null}
      </div>
      {trailing !== undefined ? (
        <div className="flex shrink-0 items-center gap-1">{trailing}</div>
      ) : null}
    </SurfaceHeader>
  );
}

function KitToolbar({
  children,
  "aria-label": ariaLabel,
  variant,
  className,
  ...rest
}: PluginToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useToolbarRoving(ref);
  return (
    <div
      {...pickRootProps(rest, { aria: true })}
      ref={ref}
      role="toolbar"
      aria-label={str(ariaLabel) ?? ""}
      onKeyDown={onKeyDown}
      className={cn(
        oneOf(variant, ["inline", "bar"] as const) === "bar"
          ? // FileViewerToolbar's row: the pane toolbar strip every host pane shares.
            "flex shrink-0 items-center gap-1.5 border-b border-overlay bg-surface px-2 py-1.5"
          : "flex items-center gap-0.5",
        str(className)
      )}
    >
      {node(children)}
    </div>
  );
}

function KitToolbarButton({
  icon,
  label,
  "aria-label": ariaLabel,
  onClick,
  pressed,
  expanded,
  disabled,
  tooltip,
  tooltipSide,
  ...rest
}: PluginToolbarButtonProps) {
  const overlayZ = useKitOverlayZClass();
  const text = nonEmpty(label);
  const name = str(ariaLabel);
  const handleClick = fn(onClick);
  const inert = disabled === true;
  const isToggle = typeof pressed === "boolean";
  const button = (
    <button
      {...pickRootProps(rest, { aria: true })}
      type="button"
      aria-label={text ? name : (name ?? "")}
      aria-pressed={isToggle ? pressed : undefined}
      // One role per button: a toggle is never also a disclosure.
      aria-expanded={!isToggle && typeof expanded === "boolean" ? expanded : undefined}
      // aria-disabled, not disabled, so the control keeps its place in the
      // toolbar's arrow-key order (the APG toolbar pattern).
      aria-disabled={inert || undefined}
      onClick={() => {
        if (!inert) handleClick?.();
      }}
      className={text ? PANE_TOOLBAR_TEXT_BUTTON_CLASS : PANE_TOOLBAR_ICON_BUTTON_CLASS}
    >
      {sizedIcon(icon, PANE_TOOLBAR_ICON_CLASS)}
      {text}
    </button>
  );
  const tip = tooltip === false ? null : tooltip === undefined ? (text ? null : name) : tooltip;
  if (!hasContent(tip)) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side={oneOf(tooltipSide, ["top", "bottom"] as const) ?? "bottom"}
        className={overlayZ}
      >
        <PluginStyleScope>{node(tip)}</PluginStyleScope>
      </TooltipContent>
    </Tooltip>
  );
}

const ErrorGlyph = SEVERITY_VISUAL.error.Icon;

function KitPaneState({
  kind,
  title,
  description,
  icon,
  action,
  onRetry,
  retryLabel,
  onCancel,
  className,
  ...rest
}: PluginPaneStateProps) {
  const rootAttributes = pickRootProps(rest);
  const state = oneOf(kind, ["loading", "empty", "error"] as const) ?? "empty";
  const heading = str(title) ?? "";
  if (state === "loading") {
    return (
      <PaneLoadingState
        rootAttributes={rootAttributes}
        variant="full"
        isLoading
        phaseLabel={heading || "Loading"}
        onCancel={fn(onCancel)}
        className={cn("min-h-40", str(className))}
      />
    );
  }
  const isError = state === "error";
  const retry = isError ? fn(onRetry) : undefined;
  const extra = content(action);
  const glyph = isError ? (
    <ErrorGlyph className="text-status-error" aria-hidden="true" />
  ) : (
    (renderIconSource(icon) ?? undefined)
  );
  return (
    <PaneState
      rootAttributes={rootAttributes}
      inFlow
      className={cn("h-full", str(className))}
      live={isError ? "alert" : "status"}
      icon={glyph}
      title={heading}
      description={content(description)}
    >
      {retry || extra !== undefined ? (
        <PaneStateActions>
          {retry ? (
            <Button variant="subtle" size="sm" onClick={() => retry()}>
              <RefreshCw aria-hidden="true" />
              {nonEmpty(retryLabel) ?? "Retry"}
            </Button>
          ) : null}
          {extra}
        </PaneStateActions>
      ) : null}
    </PaneState>
  );
}

/** A plugin's own control, rendered with the ids the enclosing field allocated. */
function FieldControlSlot({
  render,
}: {
  render: (control: PluginFormFieldControlProps) => ReactNode;
}) {
  const { controlProps } = useFieldControl({});
  const labelledBy = str(field(controlProps, "aria-labelledby"));
  const describedBy = str(field(controlProps, "aria-describedby"));
  return node(
    render({
      id: str(field(controlProps, "id")) ?? "",
      ...(labelledBy ? { "aria-labelledby": labelledBy } : {}),
      ...(describedBy ? { "aria-describedby": describedBy } : {}),
      ...(controlProps["aria-invalid"] === true ? { "aria-invalid": true as const } : {}),
    })
  );
}

// A horizontal field nudges its control down to sit on a 16px checkbox's
// centre line. The switch is 24px, so it steps up instead, centring on the
// label's first 20px line. Three attributes deep, so it outranks the field's
// own two-deep nudge whatever order the stylesheet emits them in.
const SWITCH_ROW_ALIGN =
  "[&>[data-field-control][data-slot=switch][data-size=md]]:-mt-0.5 [&>[data-field-control][data-slot=switch][data-size=sm]]:mt-0";

function KitFormField({
  label,
  description,
  error,
  required,
  htmlFor,
  orientation,
  disabled,
  children,
  className,
  ...rest
}: PluginFormFieldProps) {
  const layout = oneOf(orientation, ["vertical", "horizontal"] as const) ?? "vertical";
  const control =
    typeof children === "function" ? <FieldControlSlot render={children} /> : node(children);
  const hint = hasContent(description) ? (
    <FieldDescription>{node(description)}</FieldDescription>
  ) : null;
  const problem = hasContent(error) ? <FieldError>{node(error)}</FieldError> : null;
  const heading = (
    <FieldLabel
      accessory={
        required === true ? <span className="text-xs text-text-secondary">Required</span> : null
      }
    >
      {node(label)}
    </FieldLabel>
  );
  return (
    <Field
      {...pickRootProps(rest)}
      orientation={layout}
      controlId={nonEmpty(htmlFor)}
      disabled={disabled === true}
      className={cn(layout === "horizontal" && SWITCH_ROW_ALIGN, str(className))}
    >
      {/* A horizontal field's grid needs the control first; a vertical one reads top down. */}
      {layout === "horizontal" ? control : null}
      {heading}
      {hint}
      {layout === "vertical" ? control : null}
      {problem}
    </Field>
  );
}

// A fieldset, so a disabled group disables every control in it, named by its
// label rather than its whole legend: "Required" beside it is not part of the
// name, as a FieldLabel's accessory is not. The label wears the vertical
// FieldLabel's size and tone, so a group reads as one more field in the form.
function KitFormFieldGroup({
  label,
  description,
  error,
  required,
  disabled,
  layout,
  children,
  className,
  ...rest
}: PluginFormFieldGroupProps) {
  const baseId = useId();
  const labelId = `${baseId}label`;
  const descriptionId = hasContent(description) ? `${baseId}description` : undefined;
  const errorId = hasContent(error) ? `${baseId}error` : undefined;
  const inert = disabled === true;
  // "Required" stays out of the group's name but is still announced with it.
  const requiredId = required === true ? `${baseId}required` : undefined;
  const describedBy = [errorId, requiredId, descriptionId].filter(Boolean).join(" ") || undefined;
  return (
    <fieldset
      {...pickRootProps(rest)}
      disabled={inert}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      className={cn("m-0 min-w-0 border-0 p-0", str(className))}
    >
      <legend className="mb-2 p-0">
        <span className="flex min-w-0 items-center gap-2">
          <span id={labelId} className={cn("text-sm text-text-secondary", inert && "opacity-50")}>
            {node(label)}
          </span>
          {requiredId ? (
            <span id={requiredId} className="text-xs text-text-secondary">
              Required
            </span>
          ) : null}
        </span>
      </legend>
      {descriptionId ? (
        <p id={descriptionId} className="-mt-1 mb-2 text-xs text-text-secondary select-text">
          {node(description)}
        </p>
      ) : null}
      <div
        className={
          layout === "inline" ? "flex flex-wrap items-start gap-x-4 gap-y-2" : "grid gap-2"
        }
      >
        {node(children)}
      </div>
      {errorId ? (
        <InlineError id={errorId} className="mt-2">
          {node(error)}
        </InlineError>
      ) : null}
    </fieldset>
  );
}

// Through SettingsSwitch, so a plugin's switch is the app's one switch. `size`
// is accepted for compatibility and ignored: switches draw at one size.
function KitSwitch({
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  name,
  size: _size,
  className,
  ...rest
}: PluginSwitchProps) {
  const onChange = fn(onCheckedChange);
  const controlled = typeof checked === "boolean";
  const [uncontrolled, setUncontrolled] = useState(defaultChecked === true);
  return (
    <SettingsSwitch
      {...pickDomProps(rest)}
      checked={controlled ? checked : uncontrolled}
      onCheckedChange={(next) => {
        if (!controlled) setUncontrolled(next === true);
        onChange?.(next === true);
      }}
      disabled={disabled === true}
      name={str(name)}
      className={str(className)}
    />
  );
}

interface TabEntry {
  value: string;
  label: string;
  icon: unknown;
  badge: unknown;
}

function readTabs(items: unknown): TabEntry[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: TabEntry[] = [];
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = nonEmpty(field(entry, "value"));
    const label = str(field(entry, "label"));
    if (value === undefined || label === undefined || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label, icon: field(entry, "icon"), badge: field(entry, "badge") });
  }
  return out;
}

function tabBadge(badge: unknown): ReactNode {
  if (typeof badge === "number" && Number.isFinite(badge)) {
    return (
      <Badge size="xs" shape="pill" className="leading-none tabular-nums">
        {formatCompactCount(badge)}
      </Badge>
    );
  }
  return content(badge);
}

function KitTabs({
  items,
  value,
  onValueChange,
  "aria-label": ariaLabel,
  children,
  content: panels,
  density,
  className,
  panelClassName,
  ...rest
}: PluginTabsProps) {
  const baseId = useId();
  const tabs = readTabs(items);
  const handleChange = fn(onValueChange);
  const requested = str(value);
  const active = tabs.find((tab) => tab.value === requested)?.value ?? tabs[0]?.value;
  // By position, not by value: a value is plugin text and need not be a valid id.
  const indexOf = (id: string) => tabs.findIndex((tab) => tab.value === id);
  const tabId = (id: string) => `${baseId}tab-${indexOf(id)}`;
  const panelId = (id: string) => `${baseId}panel-${indexOf(id)}`;
  if (active === undefined) return null;
  const mapped =
    typeof panels === "object" && panels !== null && Object.hasOwn(panels, active)
      ? node(field(panels, active))
      : undefined;
  const panel =
    typeof children === "function" ? node(children(active)) : (mapped ?? node(children));
  const compact = oneOf(density, ["page", "strip"] as const) === "strip";
  // APG tabs with automatic activation: arrows and Home/End move and select in
  // one step, wrapping at the ends, and only the selected tab is a tab stop.
  const onStripKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const at = buttons.findIndex((button) => button === document.activeElement);
    if (at === -1) return;
    const last = buttons.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % buttons.length
        : event.key === "ArrowLeft"
          ? (at - 1 + buttons.length) % buttons.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (next === -1) return;
    event.preventDefault();
    const tab = tabs[next];
    const button = buttons[next];
    if (!tab || !button) return;
    button.focus();
    revealTabInStrip(event.currentTarget, button, "smooth");
    handleChange?.(tab.value);
  };
  return (
    <div {...pickRootProps(rest)} className={cn("flex min-h-0 flex-col", str(className))}>
      {/* The app's document-tab cells, divided by hairlines, with the selected
          cell filled rather than underlined: several plugin tab strips can sit
          in one window, and the accent stays free for the pane's one signal. */}
      <div
        role="tablist"
        aria-label={str(ariaLabel) ?? ""}
        onKeyDown={onStripKeyDown}
        data-kit-tabs=""
        className="flex shrink-0 overflow-x-auto border-b border-divider [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const selected = tab.value === active;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              id={tabId(tab.value)}
              aria-selected={selected}
              aria-controls={panelId(tab.value)}
              tabIndex={selected ? 0 : -1}
              data-tab={tab.value}
              onClick={(event) => {
                const strip = event.currentTarget.parentElement;
                if (strip) revealTabInStrip(strip, event.currentTarget, "smooth");
                handleChange?.(tab.value);
              }}
              className={cn(
                documentTabClassName(selected),
                "shrink-0 whitespace-nowrap",
                compact ? "h-8 gap-1.5 px-3 text-xs" : "h-9 gap-2 px-4 text-sm",
                selected && "bg-overlay-selected"
              )}
            >
              {tab.icon === undefined
                ? null
                : sizedIcon(tab.icon, compact ? "h-3.5 w-3.5" : "h-4 w-4")}
              <span>{tab.label}</span>
              {tabBadge(tab.badge) ?? null}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId(active)}
        aria-labelledby={tabId(active)}
        tabIndex={0}
        className={cn("min-h-0 flex-1", str(panelClassName))}
      >
        {panel}
      </div>
    </div>
  );
}

function KitProgressBar({
  value,
  indeterminate,
  label,
  valueText,
  size,
  className,
  ...rest
}: PluginProgressBarProps) {
  const fraction =
    indeterminate !== true && typeof value === "number" && Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : null;
  return (
    <ProgressBar
      rootAttributes={pickRootProps(rest, { aria: true })}
      value={fraction === null ? null : fraction * 100}
      max={100}
      label={nonEmpty(label) ?? "Progress"}
      valueText={nonEmpty(valueText)}
      size={oneOf(size, ["default", "thin"] as const)}
      className={str(className)}
    />
  );
}

function KitSettingsSection({
  title,
  description,
  action,
  badge,
  id,
  children,
  ...rest
}: PluginSettingsSectionProps) {
  return (
    <SettingsSection
      rootAttributes={pickRootProps(rest)}
      title={str(title) ?? ""}
      description={content(description)}
      action={content(action)}
      badge={nonEmpty(badge)}
      id={nonEmpty(id)}
    >
      {node(children)}
    </SettingsSection>
  );
}

function KitSettingsGroup({ label, id, children, ...rest }: PluginSettingsGroupProps) {
  return (
    <SettingsGroup rootAttributes={pickRootProps(rest)} label={nonEmpty(label)} id={nonEmpty(id)}>
      {node(children)}
    </SettingsGroup>
  );
}

function KitSettingsRow({
  label,
  description,
  control,
  layout,
  accessory,
  disabled,
  disabledReason,
  error,
  isModified,
  onReset,
  id,
  ...rest
}: PluginSettingsRowProps) {
  const renderControl =
    typeof control === "function"
      ? (ids: PluginSettingsRowControlIds) => node(control(ids))
      : content(control);
  return (
    <SettingsRow
      rootAttributes={pickRootProps(rest)}
      label={node(label)}
      labelText={str(label)}
      description={content(description)}
      control={renderControl}
      layout={oneOf(layout, ["inline", "stacked"] as const) ?? "inline"}
      accessory={content(accessory)}
      disabled={disabled === true}
      disabledReason={content(disabledReason)}
      error={content(error)}
      isModified={isModified === true}
      onReset={fn(onReset)}
      id={nonEmpty(id)}
    />
  );
}

function KitSettingsActions({ children, status, ...rest }: PluginSettingsActionsProps) {
  return (
    <SettingsActions rootAttributes={pickRootProps(rest)} status={content(status)}>
      {node(children)}
    </SettingsActions>
  );
}

const LIST_ROW_BOX =
  "flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-sm text-text-primary";

function KitListRow({
  title,
  subtitle,
  icon,
  meta,
  selected,
  onSelect,
  disabled,
  className,
  ...rest
}: PluginListRowProps) {
  const dom = pickDomProps(rest);
  const inert = disabled === true;
  const select = fn(onSelect);
  const body = (
    <>
      {sizedIcon(icon, "h-4 w-4 text-text-secondary")}
      <span className="flex min-w-0 flex-1 flex-col">
        {/* Code in a title steps down to the mono size the host sets code at
            (text-xs): at the row's 14px, the mono face reads a size larger. */}
        <span className="truncate [&_code]:text-xs [&_kbd]:text-xs [&_samp]:text-xs">
          {node(title)}
        </span>
        {hasContent(subtitle) ? (
          <span className="truncate text-xs text-text-secondary">{node(subtitle)}</span>
        ) : null}
      </span>
      {hasContent(meta) ? (
        <span className="shrink-0 text-xs text-text-secondary tabular-nums">{node(meta)}</span>
      ) : null}
    </>
  );
  // A listbox option (from useListNavigation): the pointer moves the one
  // cursor, so it takes the highlight alone and never a second hover fill.
  if (typeof dom.role === "string") {
    // `aria-disabled` arrives from useListNavigation's `isDisabled`.
    const unavailable = inert || dom["aria-disabled"] === true || dom["aria-disabled"] === "true";
    return (
      <div
        {...dom}
        // Unavailable rows keep their place but never select.
        onClick={(event) => {
          if (!unavailable && typeof dom.onClick === "function") dom.onClick(event);
        }}
        aria-disabled={unavailable || undefined}
        className={cn(PALETTE_ROW_CLASS, LIST_ROW_BOX, unavailable && "opacity-50", str(className))}
      >
        {body}
      </div>
    );
  }
  const rowClass = cn(LIST_DETAIL_ROW_CLASS, LIST_ROW_BOX, inert && "opacity-50", str(className));
  const marked = selected === true ? "true" : undefined;
  if (select) {
    return (
      <button
        {...dom}
        type="button"
        aria-current={marked ? "true" : undefined}
        data-selected={marked}
        disabled={inert}
        onClick={(event) => {
          if (typeof dom.onClick === "function") dom.onClick(event);
          select();
        }}
        className={cn(rowClass, PALETTE_ROW_FOCUS_CLASS)}
      >
        {body}
      </button>
    );
  }
  return (
    <div {...dom} data-selected={marked} className={rowClass}>
      {body}
    </div>
  );
}

const SEVERITIES = [
  "error",
  "danger",
  "warning",
  "success",
  "info",
  "neutral",
] as const satisfies readonly PluginSeverity[];

// SEVERITY_GLYPH's four through SEVERITY_VISUAL, plus Callout's caution octagon
// for `danger` and its neutral `i`.
const SEVERITY_ICON = {
  error: SEVERITY_VISUAL.error,
  warning: SEVERITY_VISUAL.warning,
  success: SEVERITY_VISUAL.success,
  info: SEVERITY_VISUAL.info,
  danger: { Icon: CALLOUT_ICON.danger, toneClass: "text-status-danger" },
  neutral: { Icon: CALLOUT_ICON.neutral, toneClass: "text-text-secondary" },
} as const;

function KitSeverityIcon({
  severity,
  size,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginSeverityIconProps) {
  const { Icon, toneClass } = SEVERITY_ICON[oneOf(severity, SEVERITIES) ?? "neutral"];
  const px = positive(size, 512) ?? 16;
  const label = nonEmpty(ariaLabel);
  return (
    <Icon
      {...pickRootProps(rest)}
      width={px}
      height={px}
      className={cn("shrink-0", toneClass, str(className))}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}

export const pluginKitPatterns = {
  PaneHeader: KitPaneHeader,
  Toolbar: KitToolbar,
  ToolbarButton: KitToolbarButton,
  PaneState: KitPaneState,
  FormField: KitFormField,
  FormFieldGroup: KitFormFieldGroup,
  Switch: KitSwitch,
  Tabs: KitTabs,
  ProgressBar: KitProgressBar,
  SettingsSection: KitSettingsSection,
  SettingsGroup: KitSettingsGroup,
  SettingsRow: KitSettingsRow,
  SettingsActions: KitSettingsActions,
  ListRow: KitListRow,
  SeverityIcon: KitSeverityIcon,
};

/** The severity glyph and tone, for the list adapters' log lines. */
export function severityGlyph(severity: unknown, className: string): ReactNode {
  const tone = oneOf(severity, SEVERITIES);
  if (!tone) return null;
  const { Icon, toneClass } = SEVERITY_ICON[tone];
  return <Icon className={cn("shrink-0", toneClass, className)} aria-hidden="true" />;
}
