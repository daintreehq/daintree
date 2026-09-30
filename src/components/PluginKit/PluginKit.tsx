import { isValidElement, type ChangeEvent, type ReactNode } from "react";
import type {
  PluginBadgeProps,
  PluginButtonProps,
  PluginCalloutProps,
  PluginCheckboxProps,
  PluginConfirmDialogProps,
  PluginCopyButtonProps,
  PluginDialogAction,
  PluginDialogProps,
  PluginDismissButtonProps,
  PluginDropdownMenuEntry,
  PluginDropdownMenuProps,
  PluginEmptyStateProps,
  PluginIconButtonProps,
  PluginInputProps,
  PluginKbdChordProps,
  PluginKbdProps,
  PluginScrollShadowProps,
  PluginSearchFieldProps,
  PluginSegmentedControlProps,
  PluginSelectOption,
  PluginSelectProps,
  PluginSkeletonBoneProps,
  PluginSkeletonProps,
  PluginSkeletonTextProps,
  PluginSpinnerProps,
  PluginSpinningIconProps,
  PluginTextareaProps,
  PluginTooltipProps,
  PluginTruncatedTooltipProps,
} from "@shared/types/plugin-sdk-react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CALLOUT_ICON, Callout, type CalloutSeverity } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { DismissButton } from "@/components/ui/DismissButton";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { useFieldControl } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { KBD_COMPACT_CLASS, Kbd, KbdChord } from "@/components/ui/Kbd";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { SearchField } from "@/components/ui/SearchField";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import {
  PluginKitIcon,
  isPluginKitIconName,
  renderIconSource,
  resolvePluginKitIcon,
} from "./PluginKitIcons";
import {
  ALIGNS,
  SIDES,
  asNode,
  content,
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickDomProps,
  PluginStyleScope,
  positive,
  str,
} from "./kitProps";
import { pluginKitPatterns } from "./PluginKitPatterns";
import { pluginKitLists } from "./PluginKitLists";
import { pluginKitOverlays } from "./PluginKitOverlays";
import { primeRadix } from "@/components/ui/radix-loader";

export { pickDomProps };

const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "subtle",
  "contrast",
  "destructive",
  "ghost-danger",
  "link",
  "pill",
] as const;
const BUTTON_TYPES = ["button", "submit", "reset"] as const;

function KitButton({
  children,
  variant,
  size,
  icon,
  loading,
  pressed,
  disabled,
  type,
  className,
  ...rest
}: PluginButtonProps) {
  return (
    <Button
      {...pickDomProps(rest)}
      variant={oneOf(variant, BUTTON_VARIANTS)}
      size={oneOf(size, ["default", "sm", "xs", "lg"] as const)}
      loading={loading === true}
      pressed={typeof pressed === "boolean" ? pressed : undefined}
      disabled={disabled === true}
      type={oneOf(type, BUTTON_TYPES) ?? "button"}
      className={str(className)}
    >
      {renderIconSource(icon)}
      {node(children)}
    </Button>
  );
}

const ICON_BUTTON_SIZE = { default: "icon", sm: "icon-sm", xs: "icon-xs" } as const;

function KitIconButton({
  icon,
  "aria-label": ariaLabel,
  tooltip,
  tooltipSide,
  variant,
  size,
  loading,
  pressed,
  disabled,
  type,
  className,
  ...rest
}: PluginIconButtonProps) {
  const label = str(ariaLabel) ?? "";
  const button = (
    <Button
      {...pickDomProps(rest)}
      aria-label={label}
      variant={oneOf(variant, ["ghost", "outline", "subtle", "ghost-danger"] as const) ?? "ghost"}
      size={ICON_BUTTON_SIZE[oneOf(size, ["default", "sm", "xs"] as const) ?? "sm"]}
      loading={loading === true}
      pressed={typeof pressed === "boolean" ? pressed : undefined}
      disabled={disabled === true}
      type={oneOf(type, BUTTON_TYPES) ?? "button"}
      className={str(className)}
    >
      {renderIconSource(icon)}
    </Button>
  );
  const tip = tooltip === false ? null : tooltip === undefined ? label : tooltip;
  if (!hasContent(tip)) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={oneOf(tooltipSide, SIDES) ?? "bottom"}>
        <PluginStyleScope>{node(tip)}</PluginStyleScope>
      </TooltipContent>
    </Tooltip>
  );
}

function KitTooltip({
  children,
  content,
  side,
  align,
  delayDuration,
  disabled,
}: PluginTooltipProps) {
  if (!isValidElement(children)) return null;
  if (disabled === true || !hasContent(content)) return children;
  return (
    <Tooltip delayDuration={positive(delayDuration, 10_000)}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={oneOf(side, SIDES)} align={oneOf(align, ALIGNS)}>
        <PluginStyleScope>{node(content)}</PluginStyleScope>
      </TooltipContent>
    </Tooltip>
  );
}

function KitTruncatedTooltip({
  children,
  content,
  side,
  align,
  focusable,
  isTruncated,
}: PluginTruncatedTooltipProps) {
  if (!isValidElement(children)) return null;
  return (
    <TruncatedTooltip
      content={<PluginStyleScope>{node(content)}</PluginStyleScope>}
      side={oneOf(side, SIDES)}
      align={oneOf(align, ALIGNS)}
      focusable={focusable !== false}
      isTruncated={typeof isTruncated === "boolean" ? isTruncated : undefined}
    >
      {children}
    </TruncatedTooltip>
  );
}

const SPINNER_SIZES = ["xs", "sm", "md", "lg", "xl", "2xl"] as const;

function KitSpinner({ size, className }: PluginSpinnerProps) {
  return <Spinner size={oneOf(size, SPINNER_SIZES)} className={str(className)} />;
}

function KitSpinningIcon({ icon, active, size, className }: PluginSpinningIconProps) {
  const glyph = resolvePluginKitIcon(icon);
  if (!glyph) return null;
  const px = positive(size, 512) ?? 16;
  return (
    <SpinningIcon
      icon={glyph}
      active={active === true}
      width={px}
      height={px}
      aria-hidden="true"
      className={str(className)}
    />
  );
}

const BADGE_TONES = [
  "neutral",
  "outline",
  "error",
  "danger",
  "warning",
  "success",
  "info",
] as const;

function KitBadge({ children, tone, size, shape, className, ...rest }: PluginBadgeProps) {
  const accepted = oneOf(tone, BADGE_TONES);
  return (
    <Badge
      {...pickDomProps(rest)}
      // `danger` is the kit's alias for the pill's `error` tone: a badge has no
      // glyph to tell a caution from a failure, so both wear the same tint.
      tone={accepted === "danger" ? "error" : accepted}
      size={oneOf(size, ["xs", "sm", "md"] as const)}
      shape={oneOf(shape, ["default", "pill"] as const)}
      className={str(className)}
    >
      {node(children)}
    </Badge>
  );
}

function KitCheckbox({
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  invalid,
  required,
  name,
  value,
  size,
  className,
  ...rest
}: PluginCheckboxProps) {
  const onChange = fn(onCheckedChange);
  return (
    <Checkbox
      {...pickDomProps(rest)}
      checked={
        checked === "indeterminate" ? checked : typeof checked === "boolean" ? checked : undefined
      }
      defaultChecked={typeof defaultChecked === "boolean" ? defaultChecked : undefined}
      onCheckedChange={onChange ? (next) => onChange(next === true) : undefined}
      disabled={disabled === true}
      invalid={typeof invalid === "boolean" ? invalid : undefined}
      required={required === true}
      name={str(name)}
      value={str(value)}
      size={oneOf(size, ["sm", "md"] as const)}
      className={str(className)}
    />
  );
}

function textValue(value: unknown): string | number | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

function numberOrString(value: unknown): string | number | undefined {
  return textValue(value);
}

const INPUT_TYPES = [
  "text",
  "search",
  "email",
  "url",
  "password",
  "number",
  "tel",
  "date",
  "time",
  "datetime-local",
] as const;

function KitInput({
  type,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  name,
  disabled,
  readOnly,
  required,
  autoFocus,
  autoComplete,
  spellCheck,
  maxLength,
  min,
  max,
  step,
  invalid,
  density,
  className,
  onChange,
  ...rest
}: PluginInputProps) {
  const handleChange = fn(onChange);
  const handleValue = fn(onValueChange);
  return (
    <Input
      {...pickDomProps(rest)}
      type={oneOf(type, INPUT_TYPES) ?? "text"}
      value={textValue(value)}
      defaultValue={textValue(defaultValue)}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        handleChange?.(event);
        handleValue?.(event.target.value);
      }}
      placeholder={str(placeholder)}
      name={str(name)}
      disabled={disabled === true}
      readOnly={readOnly === true}
      required={required === true}
      autoFocus={autoFocus === true}
      autoComplete={str(autoComplete)}
      spellCheck={typeof spellCheck === "boolean" ? spellCheck : undefined}
      maxLength={positive(maxLength, Number.MAX_SAFE_INTEGER)}
      min={numberOrString(min)}
      max={numberOrString(max)}
      step={numberOrString(step)}
      invalid={typeof invalid === "boolean" ? invalid : undefined}
      density={oneOf(density, ["default", "compact"] as const)}
      className={str(className)}
    />
  );
}

function KitTextarea({
  value,
  defaultValue,
  onValueChange,
  placeholder,
  name,
  rows,
  disabled,
  readOnly,
  required,
  autoFocus,
  spellCheck,
  maxLength,
  invalid,
  density,
  variant,
  resize,
  className,
  onChange,
  ...rest
}: PluginTextareaProps) {
  const handleChange = fn(onChange);
  const handleValue = fn(onValueChange);
  return (
    <Textarea
      {...pickDomProps(rest)}
      value={str(value)}
      defaultValue={str(defaultValue)}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
        handleChange?.(event);
        handleValue?.(event.target.value);
      }}
      placeholder={str(placeholder)}
      name={str(name)}
      rows={positive(rows, 1000)}
      disabled={disabled === true}
      readOnly={readOnly === true}
      required={required === true}
      autoFocus={autoFocus === true}
      spellCheck={typeof spellCheck === "boolean" ? spellCheck : undefined}
      maxLength={positive(maxLength, Number.MAX_SAFE_INTEGER)}
      invalid={typeof invalid === "boolean" ? invalid : undefined}
      density={oneOf(density, ["default", "compact"] as const)}
      variant={oneOf(variant, ["default", "code"] as const)}
      resize={oneOf(resize, ["vertical", "none"] as const)}
      className={str(className)}
    />
  );
}

type SelectEntry =
  | { kind: "option"; option: PluginSelectOption }
  | { kind: "group"; label: string; options: PluginSelectOption[] };

function readSelectOption(value: unknown, seen: Set<string>): PluginSelectOption | null {
  if (typeof value !== "object" || value === null) return null;
  const optionValue = nonEmpty(field(value, "value"));
  const label = str(field(value, "label"));
  // Radix reserves "" for "no selection", and a repeated value makes two rows
  // report the same pick.
  if (optionValue === undefined || label === undefined || seen.has(optionValue)) return null;
  seen.add(optionValue);
  const icon = field(value, "icon");
  return {
    value: optionValue,
    label,
    description: str(field(value, "description")),
    // Kept only when it names a glyph, so the row never reserves an empty gutter.
    icon: isPluginKitIconName(icon) ? icon : undefined,
    disabled: field(value, "disabled") === true,
  };
}

/** Plugin options, narrowed to what the Select can render. Exported for tests. */
export function normalizeSelectOptions(options: unknown): SelectEntry[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  const entries: SelectEntry[] = [];
  for (const entry of options) {
    if (typeof entry !== "object" || entry === null) continue;
    const groupOptions = field(entry, "options");
    if (Array.isArray(groupOptions)) {
      const label = str(field(entry, "label")) ?? "";
      const inner = groupOptions
        .map((option) => readSelectOption(option, seen))
        .filter((option): option is PluginSelectOption => option !== null);
      if (inner.length > 0) entries.push({ kind: "group", label, options: inner });
      continue;
    }
    const option = readSelectOption(entry, seen);
    if (option) entries.push({ kind: "option", option });
  }
  return entries;
}

function renderSelectItem(option: PluginSelectOption) {
  const Glyph = option.icon === undefined ? undefined : resolvePluginKitIcon(option.icon);
  return (
    <SelectItem
      key={option.value}
      value={option.value}
      disabled={option.disabled}
      description={option.description}
    >
      {Glyph ? (
        // Inside the item text, so the trigger mirrors the glyph with the label.
        <span className="inline-flex min-w-0 items-center gap-2">
          <Glyph className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
          {option.label}
        </span>
      ) : (
        option.label
      )}
    </SelectItem>
  );
}

function KitSelect(props: PluginSelectProps) {
  const {
    options,
    value,
    defaultValue,
    onValueChange,
    placeholder,
    disabled,
    density,
    name,
    id,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
    className,
  } = props;
  // Passing `value` at all makes the Select controlled, so a cleared value
  // (`""`, `null`, `undefined`) goes back to the placeholder rather than
  // leaving Radix holding the last pick uncontrolled.
  const controlled = Object.hasOwn(props, "value");
  const entries = normalizeSelectOptions(options);
  // Radix's trigger does not read the field context the other controls do, so
  // a Select inside a kit FormField is wired here.
  const { controlProps } = useFieldControl({
    "aria-label": str(ariaLabel),
    "aria-labelledby": str(ariaLabelledBy),
    "aria-describedby": str(ariaDescribedBy),
  });
  return (
    <Select
      value={controlled ? (str(value) ?? "") : undefined}
      defaultValue={controlled ? undefined : str(defaultValue)}
      onValueChange={fn(onValueChange)}
      disabled={disabled === true}
      name={str(name)}
    >
      <SelectTrigger
        id={str(id)}
        aria-label={str(ariaLabel)}
        aria-labelledby={str(ariaLabelledBy)}
        aria-describedby={str(ariaDescribedBy)}
        {...controlProps}
        density={oneOf(density, ["default", "compact"] as const)}
        className={str(className)}
      >
        <SelectValue placeholder={str(placeholder)} />
      </SelectTrigger>
      <SelectContent>
        {entries.map((entry, index) =>
          entry.kind === "option" ? (
            renderSelectItem(entry.option)
          ) : (
            <SelectGroup key={`group-${index}`}>
              {entry.label ? <SelectLabel>{entry.label}</SelectLabel> : null}
              {entry.options.map(renderSelectItem)}
            </SelectGroup>
          )
        )}
      </SelectContent>
    </Select>
  );
}

function readSegmentedOptions(options: unknown): SegmentedRadioOption<string>[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  const out: SegmentedRadioOption<string>[] = [];
  for (const entry of options) {
    if (typeof entry !== "object" || entry === null) continue;
    const optionValue = str(field(entry, "value"));
    const label = str(field(entry, "label"));
    if (optionValue === undefined || label === undefined || seen.has(optionValue)) continue;
    seen.add(optionValue);
    const tooltip = asNode(field(entry, "tooltip"));
    out.push({
      value: optionValue,
      label,
      disabled: field(entry, "disabled") === true,
      ariaLabel: str(field(entry, "aria-label")),
      tooltip: content(tooltip),
    });
  }
  return out;
}

function KitSegmentedControl({
  options,
  value,
  onValueChange,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  disabled,
  fullWidth,
  density,
  className,
}: PluginSegmentedControlProps) {
  const handleChange = fn(onValueChange);
  return (
    <SegmentedRadioGroup
      options={readSegmentedOptions(options)}
      value={str(value) ?? ""}
      onChange={(next) => handleChange?.(next)}
      aria-label={str(ariaLabel) ?? ""}
      aria-describedby={str(ariaDescribedBy)}
      disabled={disabled === true}
      fullWidth={fullWidth === true}
      density={oneOf(density, ["default", "compact"] as const)}
      className={str(className)}
    />
  );
}

function KitKbd({ children, density, className }: PluginKbdProps) {
  if (density === "compact") {
    // The host Kbd has one size; its compact box is the class KbdChord draws with.
    return <kbd className={cn(KBD_COMPACT_CLASS, str(className))}>{node(children)}</kbd>;
  }
  return <Kbd className={str(className)}>{node(children)}</Kbd>;
}

function KitKbdChord({
  shortcut,
  density,
  foreground,
  "aria-label": ariaLabel,
  className,
}: PluginKbdChordProps) {
  const combo = nonEmpty(shortcut);
  if (!combo) return null;
  return (
    <KbdChord
      shortcut={combo}
      density={oneOf(density, ["default", "compact", "bare"] as const)}
      foreground={oneOf(foreground, ["secondary", "primary", "inverse"] as const)}
      aria-label={str(ariaLabel)}
      className={str(className)}
    />
  );
}

function KitCopyButton(props: PluginCopyButtonProps) {
  const { text, tooltip, tooltipSide, onCopied, onCopyError, announcement, disabled, className } =
    props;
  const payload = typeof text === "string" || typeof text === "function" ? text : "";
  const shared = {
    text: payload,
    tooltip: content(tooltip),
    tooltipSide: oneOf(tooltipSide, SIDES),
    onCopied: fn(onCopied),
    onCopyError: fn(onCopyError),
    announcement: nonEmpty(announcement),
    disabled: disabled === true,
    className: str(className),
  };
  const label = nonEmpty(props.label);
  if (label) {
    return (
      <CopyButton
        {...shared}
        label={label}
        aria-label={str(props["aria-label"])}
        variant={oneOf("variant" in props ? props.variant : undefined, [
          "ghost",
          "outline",
          "subtle",
        ] as const)}
        size={oneOf(props.size, ["xs", "sm", "default"] as const)}
      />
    );
  }
  const iconSize = oneOf(props.size, ["xs", "sm"] as const);
  return (
    <CopyButton
      {...shared}
      aria-label={nonEmpty(props["aria-label"]) ?? "Copy"}
      size={iconSize === "sm" ? "icon-sm" : "icon-xs"}
    />
  );
}

function KitDismissButton({
  "aria-label": ariaLabel,
  onClick,
  tooltip,
  disabled,
  className,
}: PluginDismissButtonProps) {
  const handleClick = fn(onClick);
  return (
    <DismissButton
      aria-label={nonEmpty(ariaLabel) ?? "Dismiss"}
      onClick={() => handleClick?.()}
      tooltip={content(tooltip)}
      disabled={disabled === true}
      className={str(className)}
    />
  );
}

const CALLOUT_SEVERITIES = [
  "error",
  "warning",
  "danger",
  "success",
  "info",
  "neutral",
] as const satisfies readonly CalloutSeverity[];

function KitCallout({
  severity,
  children,
  title,
  action,
  actionPlacement,
  onDismiss,
  dismissLabel,
  variant,
  icon,
  size,
  className,
  ...rest
}: PluginCalloutProps) {
  const tone = oneOf(severity, CALLOUT_SEVERITIES) ?? "neutral";
  const actionNode = content(action);
  const below = actionPlacement === "below";
  const dismiss = fn(onDismiss);
  const dismissName = nonEmpty(dismissLabel) ?? "Dismiss";
  const glyph = tone === "neutral" ? resolvePluginKitIcon(icon) : undefined;

  if (variant === "strip") {
    return (
      <KitCalloutStrip
        tone={tone}
        title={content(title)}
        body={content(children)}
        action={actionNode}
        below={below}
        onDismiss={dismiss}
        dismissLabel={dismissName}
        glyph={glyph}
        role={oneOf(rest.role, ["alert", "status"] as const)}
        ariaLive={oneOf(rest["aria-live"], ["off", "polite", "assertive"] as const)}
        testId={str(rest["data-testid"])}
        className={str(className)}
      />
    );
  }

  const trailing =
    (actionNode !== undefined && !below) || dismiss ? (
      <span className="flex items-center gap-1">
        {below ? null : actionNode}
        {dismiss ? <DismissButton aria-label={dismissName} onClick={() => dismiss()} /> : null}
      </span>
    ) : undefined;
  const shared = {
    ...pickDomProps(rest),
    title: content(title),
    action: trailing,
    size: oneOf(size, ["default", "compact"] as const),
    className: str(className),
    children: (
      <>
        {node(children)}
        {below && actionNode !== undefined ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">{actionNode}</div>
        ) : null}
      </>
    ),
  };
  // A severity callout always wears its severity's glyph; only a neutral one
  // may carry a domain glyph of the plugin's choosing.
  if (tone === "neutral") {
    return <Callout {...shared} severity="neutral" icon={glyph} />;
  }
  return <Callout {...shared} severity={tone} />;
}

type BannerGlyph = NonNullable<Parameters<typeof InlineStatusBanner>[0]["icon"]>;

/**
 * The strip is the host's pane banner, not a restyled box: the same band,
 * tint and control layout Daintree draws across its own panes. The kit's
 * `action` node goes in the banner's trailing slot, so it keeps the kit's
 * one-control shape rather than the banner's action objects.
 */
function KitCalloutStrip({
  tone,
  title,
  body,
  action,
  below,
  onDismiss,
  dismissLabel,
  glyph,
  role,
  ariaLive,
  testId,
  className,
}: {
  tone: (typeof CALLOUT_SEVERITIES)[number];
  title: ReactNode;
  body: ReactNode;
  action: ReactNode;
  below: boolean;
  onDismiss: (() => void) | undefined;
  dismissLabel: string;
  glyph: BannerGlyph | undefined;
  role: "alert" | "status" | undefined;
  ariaLive: "off" | "polite" | "assertive" | undefined;
  testId: string | undefined;
  className: string | undefined;
}) {
  // Without a title the body is the headline, so the band is still one line.
  const headline = title ?? body ?? "";
  const description = title === undefined ? undefined : body;
  // The banner sets its description in a <p>: text stays there, anything
  // element-shaped goes in the block slot beneath it so it cannot nest a
  // <div> or a control inside the paragraph.
  const inline = typeof description === "string" || typeof description === "number";
  const common = {
    title: <PluginStyleScope>{headline}</PluginStyleScope>,
    description: inline ? description : undefined,
    descriptionExtras:
      description === undefined || inline ? undefined : (
        <PluginStyleScope block>{description}</PluginStyleScope>
      ),
    trailingSlot: action,
    layout: below ? ("stacked" as const) : ("pane" as const),
    inset: false,
    role,
    ariaLive,
    closeAriaLabel: dismissLabel,
    onClose: onDismiss,
    className,
    "data-testid": testId,
  };
  // `danger` is a caution about a destructive consequence: the banner has no
  // separate tier for it, so it takes the error band with the octagon glyph.
  if (tone === "error" || tone === "danger") {
    return (
      <InlineStatusBanner
        {...common}
        severity="error"
        icon={tone === "danger" ? CALLOUT_ICON.danger : undefined}
      />
    );
  }
  // Green only ever says "this just happened" and a kit strip does not time
  // itself out, so a success strip stands as a neutral band with the check.
  if (tone === "success") {
    return <InlineStatusBanner {...common} severity="neutral" icon={SEVERITY_GLYPH.success} />;
  }
  return (
    <InlineStatusBanner {...common} severity={tone} icon={tone === "neutral" ? glyph : undefined} />
  );
}

function KitEmptyState({
  title,
  variant,
  scale,
  description,
  icon,
  action,
  className,
}: PluginEmptyStateProps) {
  const kind = oneOf(variant, ["zero-data", "filtered-empty", "user-cleared"] as const);
  const size = oneOf(scale, ["canvas", "sidebar", "popover"] as const) ?? "canvas";
  const heading = str(title) ?? "";
  const glyph = renderIconSource(icon) ?? undefined;
  const actionNode = content(action);
  const classes = str(className);
  if (kind === "user-cleared") {
    return (
      <EmptyState
        variant="user-cleared"
        scale={size === "canvas" ? "canvas" : "sidebar"}
        title={heading}
        icon={glyph}
        className={classes}
      />
    );
  }
  // The host only lets a canvas-scale state carry a description.
  if (size === "canvas") {
    const body = content(description);
    return kind === "filtered-empty" ? (
      <EmptyState
        variant="filtered-empty"
        scale="canvas"
        title={heading}
        description={body}
        action={actionNode}
        className={classes}
      />
    ) : (
      <EmptyState
        variant="zero-data"
        scale="canvas"
        title={heading}
        description={body}
        icon={glyph}
        action={actionNode}
        className={classes}
      />
    );
  }
  return kind === "filtered-empty" ? (
    <EmptyState
      variant="filtered-empty"
      scale={size}
      title={heading}
      action={actionNode}
      className={classes}
    />
  ) : (
    <EmptyState
      variant="zero-data"
      scale={size}
      title={heading}
      icon={glyph}
      action={actionNode}
      className={classes}
    />
  );
}

function KitSkeleton({ children, label, className }: PluginSkeletonProps) {
  return (
    <Skeleton label={nonEmpty(label)} className={str(className)}>
      {node(children)}
    </Skeleton>
  );
}

function KitSkeletonBone({ className, heightPx, shimmer, immediate }: PluginSkeletonBoneProps) {
  return (
    <SkeletonBone
      className={str(className)}
      heightPx={positive(heightPx, 10_000)}
      shimmer={shimmer === true}
      immediate={immediate === true}
    />
  );
}

function KitSkeletonText({ lines, shimmer, immediate, className }: PluginSkeletonTextProps) {
  return (
    <SkeletonText
      lines={typeof lines === "number" && Number.isFinite(lines) ? lines : undefined}
      shimmer={shimmer === true}
      immediate={immediate === true}
      className={str(className)}
    />
  );
}

function KitScrollShadow({
  children,
  className,
  scrollClassName,
  compact,
  ref,
  ...rest
}: PluginScrollShadowProps) {
  return (
    <ScrollShadow
      {...pickDomProps(rest)}
      ref={typeof ref === "function" || (typeof ref === "object" && ref !== null) ? ref : undefined}
      className={str(className)}
      scrollClassName={str(scrollClassName)}
      compact={compact === true}
    >
      {node(children)}
    </ScrollShadow>
  );
}

function KitSearchField({
  value,
  onValueChange,
  onClear,
  placeholder,
  "aria-label": ariaLabel,
  clearLabel,
  size,
  autoFocus,
  disabled,
  invalid,
  className,
  onChange,
  ref,
  ...rest
}: PluginSearchFieldProps) {
  const handleChange = fn(onChange);
  const handleValue = fn(onValueChange);
  return (
    <SearchField
      {...pickDomProps(rest)}
      // SearchField's own `ref` slot is `inputRef`; the kit keeps the usual name.
      inputRef={
        typeof ref === "function" || (typeof ref === "object" && ref !== null) ? ref : undefined
      }
      value={str(value) ?? ""}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        handleChange?.(event);
        handleValue?.(event.target.value);
      }}
      onClear={fn(onClear)}
      placeholder={str(placeholder)}
      aria-label={str(ariaLabel)}
      clearLabel={nonEmpty(clearLabel)}
      size={oneOf(size, ["compact", "dense", "palette"] as const)}
      autoFocus={autoFocus === true}
      disabled={disabled === true}
      invalid={invalid === true}
      fieldClassName={str(className)}
    />
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

function renderMenuEntry(entry: PluginDropdownMenuEntry, index: number): ReactNode {
  if (typeof entry !== "object" || entry === null) return null;
  const key = `entry-${index}`;
  switch (entry.type) {
    case "radio-group": {
      const choices = readRadioItems(entry.items);
      if (choices.length === 0) return null;
      const onValueChange = fn(entry.onValueChange);
      const heading = nonEmpty(entry.label);
      return (
        <DropdownMenuRadioGroup
          key={key}
          value={str(entry.value) ?? ""}
          onValueChange={(next) => onValueChange?.(next)}
          aria-label={heading}
        >
          {heading ? <DropdownMenuLabel>{heading}</DropdownMenuLabel> : null}
          {choices.map((choice) => (
            <DropdownMenuRadioItem
              key={choice.value}
              value={choice.value}
              disabled={choice.disabled}
            >
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      );
    }
    case "separator":
      return <DropdownMenuSeparator key={key} />;
    case "label": {
      const label = str(entry.label);
      return label ? <DropdownMenuLabel key={key}>{label}</DropdownMenuLabel> : null;
    }
    case "checkbox": {
      const label = str(entry.label);
      const onCheckedChange = fn(entry.onCheckedChange);
      if (!label) return null;
      return (
        <DropdownMenuCheckboxItem
          key={key}
          checked={entry.checked === true}
          onCheckedChange={(next) => onCheckedChange?.(next === true)}
          disabled={entry.disabled === true}
        >
          {label}
        </DropdownMenuCheckboxItem>
      );
    }
    case undefined:
    case "item": {
      const label = str(entry.label);
      const onSelect = fn(entry.onSelect);
      if (!label) return null;
      const Glyph = entry.icon === undefined ? undefined : resolvePluginKitIcon(entry.icon);
      return (
        <DropdownMenuItem
          key={key}
          onSelect={() => onSelect?.()}
          disabled={entry.disabled === true}
          destructive={entry.destructive === true}
        >
          {Glyph ? (
            // `data-menu-icon` gives text-only rows in the same menu the matching gutter.
            <span data-menu-icon="" aria-hidden="true" className="mr-2 inline-flex shrink-0">
              <Glyph className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          ) : null}
          {label}
          <DropdownMenuShortcut shortcut={str(entry.shortcut)} />
        </DropdownMenuItem>
      );
    }
    default:
      return null;
  }
}

function stopEvent(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function KitDropdownMenu({
  trigger,
  items,
  side,
  align,
  open,
  onOpenChange,
  "aria-label": ariaLabel,
  onCloseAutoFocus,
  stopPropagation,
}: PluginDropdownMenuProps) {
  if (!isValidElement(trigger)) return null;
  const entries: readonly PluginDropdownMenuEntry[] = Array.isArray(items) ? items : [];
  const closeAutoFocus = fn(onCloseAutoFocus);
  // Only the view's ancestors are cut off: the menu's own handlers run on the
  // content element itself, so Radix's keyboard and focus policy are untouched.
  const isolate = stopPropagation === true;
  return (
    <DropdownMenu
      open={typeof open === "boolean" ? open : undefined}
      onOpenChange={fn(onOpenChange)}
    >
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side={oneOf(side, SIDES)}
        align={oneOf(align, ALIGNS)}
        aria-label={str(ariaLabel)}
        onCloseAutoFocus={closeAutoFocus ? (event) => closeAutoFocus(event) : undefined}
        onClick={isolate ? stopEvent : undefined}
        onPointerDown={isolate ? stopEvent : undefined}
        onKeyDown={isolate ? stopEvent : undefined}
      >
        {entries.map(renderMenuEntry)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function readDialogAction(action: PluginDialogAction | undefined): DialogAction | undefined {
  if (typeof action !== "object" || action === null) return undefined;
  const label = nonEmpty(action.label);
  const onClick = fn(action.onClick);
  if (!label || !onClick) return undefined;
  return {
    label,
    onClick: () => onClick(),
    disabled: action.disabled === true,
    loading: action.loading === true,
    intent: oneOf(action.intent, ["default", "destructive"] as const),
    icon: renderIconSource(action.icon) ?? undefined,
  };
}

/**
 * A disabled primary's reason, for the footer hint. Only the primary: it is
 * the one button the host points at the hint with `aria-describedby`.
 */
function disabledReasonOf(action: PluginDialogAction | undefined): ReactNode {
  if (typeof action !== "object" || action === null || action.disabled !== true) return undefined;
  return content(action.disabledReason);
}

function iconNode(source: unknown): ReactNode {
  return renderIconSource(source) ?? undefined;
}

function zIndexOf(layer: unknown): "nested" | undefined {
  return layer === "nested" ? "nested" : undefined;
}

function noop() {}

function KitDialog({
  open,
  onClose,
  title,
  icon,
  description,
  children,
  size,
  primaryAction,
  secondaryAction,
  hint,
  footer,
  dismissible,
  layer,
  "data-testid": testId,
}: PluginDialogProps) {
  const primary = readDialogAction(primaryAction);
  const secondary = readDialogAction(secondaryAction);
  const custom = content(footer);
  const footerHint =
    content(hint) ?? (custom === undefined ? disabledReasonOf(primaryAction) : undefined);
  return (
    <AppDialog
      isOpen={open === true}
      onClose={fn(onClose) ?? noop}
      size={oneOf(size, ["sm", "md", "lg"] as const) ?? "md"}
      dismissible={dismissible !== false}
      zIndex={zIndexOf(layer)}
      data-testid={nonEmpty(testId)}
    >
      <AppDialog.Header>
        <AppDialog.Title icon={iconNode(icon)}>{node(title)}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <PluginStyleScope block className="space-y-3">
          {hasContent(description) ? (
            <AppDialog.Description>{node(description)}</AppDialog.Description>
          ) : null}
          {node(children)}
        </PluginStyleScope>
      </AppDialog.Body>
      {custom !== undefined ? (
        <AppDialog.Footer hint={footerHint}>
          {/* One container: a hint spreads the footer, and loose controls would scatter across it. */}
          <PluginStyleScope block className="flex shrink-0 items-center gap-3">
            {custom}
          </PluginStyleScope>
        </AppDialog.Footer>
      ) : primary || secondary ? (
        <AppDialog.Footer primaryAction={primary} secondaryAction={secondary} hint={footerHint} />
      ) : null}
    </AppDialog>
  );
}

function KitConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  variant,
  icon,
  loading,
  confirmDisabled,
  typedNameTarget,
  hint,
  layer,
}: PluginConfirmDialogProps) {
  const confirm = fn(onConfirm);
  const common = {
    isOpen: open === true,
    onClose: fn(onClose) ?? noop,
    onConfirm: () => confirm?.(),
    title: node(title),
    titleIcon: iconNode(icon),
    description: content(description),
    children: hasContent(children) ? (
      <PluginStyleScope block>{node(children)}</PluginStyleScope>
    ) : undefined,
    confirmLabel: nonEmpty(confirmLabel) ?? "Confirm",
    cancelLabel: nonEmpty(cancelLabel),
    isConfirmLoading: loading === true,
    confirmDisabled: confirmDisabled === true,
    hint: content(hint),
    zIndex: zIndexOf(layer),
  };
  const tone = oneOf(variant, ["default", "destructive", "info"] as const) ?? "default";
  if (tone === "destructive") {
    return (
      <ConfirmDialog
        {...common}
        variant="destructive"
        typedNameTarget={nonEmpty(typedNameTarget)}
      />
    );
  }
  return <ConfirmDialog {...common} variant={tone} />;
}

/**
 * The adapters `@daintreehq/plugin-ui` serves, keyed by their public names.
 * Loaded on first use (src/pluginUi/kit.tsx), so none of the host components
 * behind them enters the facade chunk.
 */
export const pluginKit = {
  Button: KitButton,
  IconButton: KitIconButton,
  Tooltip: KitTooltip,
  TruncatedTooltip: KitTruncatedTooltip,
  Spinner: KitSpinner,
  SpinningIcon: KitSpinningIcon,
  Badge: KitBadge,
  Checkbox: KitCheckbox,
  Input: KitInput,
  Textarea: KitTextarea,
  Select: KitSelect,
  SegmentedControl: KitSegmentedControl,
  Kbd: KitKbd,
  KbdChord: KitKbdChord,
  CopyButton: KitCopyButton,
  DismissButton: KitDismissButton,
  Callout: KitCallout,
  EmptyState: KitEmptyState,
  Skeleton: KitSkeleton,
  SkeletonBone: KitSkeletonBone,
  SkeletonText: KitSkeletonText,
  ScrollShadow: KitScrollShadow,
  SearchField: KitSearchField,
  DropdownMenu: KitDropdownMenu,
  Dialog: KitDialog,
  ConfirmDialog: KitConfirmDialog,
  Icon: PluginKitIcon,
  ...pluginKitPatterns,
  ...pluginKitLists,
  ...pluginKitOverlays,
};

export type PluginKit = typeof pluginKit;

/**
 * Everything the kit's first frame depends on beyond this chunk: the Radix
 * primitives behind its overlays and selects load on their own, so "ready"
 * waits for them too.
 */
export async function preparePluginKit(): Promise<void> {
  await primeRadix();
}
