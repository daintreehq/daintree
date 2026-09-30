import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ChevronRight } from "lucide-react";
import type {
  PluginAccordionProps,
  PluginCardProps,
  PluginDescriptionItem,
  PluginDescriptionListItemProps,
  PluginDescriptionListProps,
  PluginDisclosureProps,
  PluginDividerProps,
  PluginResizableSplitProps,
  PluginSectionLabelProps,
} from "@shared/types/plugin-sdk-react";
import { Card, ChoiceCard } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/CopyButton";
import { InsetSurface } from "@/components/ui/insetSurface";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { LIST_LABEL_CLASS, SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { resolveSplitterKey, type SplitterGrowKey } from "@/hooks/useSplitterKeys";
import { cn } from "@/lib/utils";
import {
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickDomProps,
  pickRootProps,
  positive,
  str,
} from "./kitProps";

const CARD_SPACE = {
  md: { x: "px-4", top: "pt-3.5", bottom: "pb-3.5", y: "py-3.5" },
  sm: { x: "px-3", top: "pt-2.5", bottom: "pb-2.5", y: "py-2.5" },
} as const;

// The host `Card` frame for a static card and the host `ChoiceCard` for a
// clickable one: a card that is itself the control owns focus and press, and
// is outlined at rest, so `variant` only applies to the static frame. Inside a
// button every part is a span, since a button holds phrasing content only.
function KitCard(props: PluginCardProps) {
  const {
    title,
    description,
    children,
    footer,
    variant,
    padding,
    className,
    onClick,
    actions,
    disabled,
    ...rest
  } = props;
  const baseId = useId();
  const click = fn(onClick);
  const pad = oneOf(padding, ["none", "sm", "md"] as const) ?? "md";
  const space = CARD_SPACE[pad === "sm" ? "sm" : "md"];
  const hasTitle = hasContent(title);
  const hasDescription = hasContent(description);
  const hasActions = !click && hasContent(actions);
  const hasBody = hasContent(children);
  const hasFooter = hasContent(footer);
  const titleId = `${baseId}title`;
  const descriptionId = `${baseId}description`;
  const Block = click ? "span" : "div";
  const Heading = click ? "span" : "h3";
  const Line = click ? "span" : "p";

  const header =
    hasTitle || hasDescription || hasActions ? (
      <Block
        className={cn(
          "flex min-w-0 items-start gap-3",
          space.x,
          space.top,
          (!hasBody || pad === "none") && space.bottom
        )}
      >
        <Block className="block min-w-0 flex-1">
          {hasTitle ? (
            <Heading
              id={titleId}
              className="block break-words text-sm font-semibold text-text-primary"
            >
              {node(title)}
            </Heading>
          ) : null}
          {hasDescription ? (
            <Line
              id={descriptionId}
              className={cn(
                "block text-xs leading-relaxed text-text-secondary",
                hasTitle && "mt-1"
              )}
            >
              {node(description)}
            </Line>
          ) : null}
        </Block>
        {hasActions ? (
          <div className="flex shrink-0 items-center gap-2">{node(actions)}</div>
        ) : null}
      </Block>
    ) : null;
  const body = hasBody ? (
    <Block
      className={cn(
        "block min-w-0",
        pad !== "none" && space.x,
        pad !== "none" && (header ? space.bottom : space.y)
      )}
    >
      <InsetSurface>{node(children)}</InsetSurface>
    </Block>
  ) : null;
  const foot = hasFooter ? (
    <Block
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-end gap-2 border-t border-divider",
        space.x,
        space.y
      )}
    >
      {node(footer)}
    </Block>
  ) : null;

  if (click) {
    return (
      <ChoiceCard
        {...pickDomProps(rest)}
        onClick={click}
        disabled={disabled === true}
        aria-labelledby={hasTitle ? titleId : undefined}
        aria-describedby={hasDescription ? descriptionId : undefined}
        className={cn("min-w-0 flex-col items-stretch p-0", str(className))}
      >
        {header}
        {body}
        {foot}
      </ChoiceCard>
    );
  }
  return (
    <Card
      {...pickDomProps(rest)}
      variant={oneOf(variant, ["default", "inset"] as const) === "inset" ? "subtle" : "default"}
      padding="none"
      className={cn("flex min-w-0 flex-col", str(className))}
    >
      {header}
      {body}
      {foot}
    </Card>
  );
}

// An `hr` is the separator role without a hand-rolled one, which the resize
// contract keeps for draggable edges. A labelled line is not a separator: a
// separator's children are presentational, so its label would never be read.
function KitDivider({ orientation, label, className, ...rest }: PluginDividerProps) {
  const root = pickRootProps(rest);
  if (oneOf(orientation, ["horizontal", "vertical"] as const) === "vertical") {
    return (
      <hr
        {...root}
        aria-orientation="vertical"
        className={cn(
          "m-0 h-auto w-px shrink-0 self-stretch border-0 bg-border-divider",
          str(className)
        )}
      />
    );
  }
  if (hasContent(label)) {
    return (
      <div {...root} className={cn("flex min-w-0 items-center gap-3", str(className))}>
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border-divider" />
        <span className="min-w-0 truncate text-xs text-text-secondary">{node(label)}</span>
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border-divider" />
      </div>
    );
  }
  return (
    <hr
      {...root}
      className={cn("m-0 h-px w-full shrink-0 border-0 bg-border-divider", str(className))}
    />
  );
}

function KitSectionLabel({ children, variant, as, className, ...rest }: PluginSectionLabelProps) {
  const list = oneOf(variant, ["section", "list"] as const) === "list";
  const Tag = oneOf(as, ["h2", "h3", "h4", "div"] as const) ?? (list ? "div" : "h3");
  return (
    <Tag
      {...pickRootProps(rest)}
      className={cn(list ? LIST_LABEL_CLASS : SECTION_LABEL_CLASS, str(className))}
    >
      {node(children)}
    </Tag>
  );
}

const SPLIT_DEFAULT_PX = 280;
const SPLIT_MIN_PX = 160;
const SPLIT_MAX_PX = 640;
const SPLIT_LIMIT_PX = 100_000;
const SPLIT_STEP_PX = 10;
const SPLIT_LARGE_STEP_PX = 50;
// What the handle takes from the container: the vertical track, or the row.
const SPLIT_TRACK_PX = { horizontal: 6, vertical: 12 } as const;

interface SplitDrag {
  size: number;
  collapsed: boolean;
}

function growKeyOf(horizontal: boolean, sizedFirst: boolean): SplitterGrowKey {
  if (horizontal) return sizedFirst ? "ArrowRight" : "ArrowLeft";
  return sizedFirst ? "ArrowDown" : "ArrowUp";
}

/** Whether a key would shrink the pane: ignored while it is collapsed. Exported for tests. */
export function isShrinkKey(key: string, growKey: SplitterGrowKey): boolean {
  switch (growKey) {
    case "ArrowRight":
      return key === "ArrowLeft" || key === "Home";
    case "ArrowLeft":
      return key === "ArrowRight" || key === "Home";
    case "ArrowDown":
      return key === "ArrowUp" || key === "PageUp" || key === "Home";
    case "ArrowUp":
      return key === "ArrowDown" || key === "PageDown" || key === "Home";
  }
}

// The drag measures nothing: the size is the start size plus the pointer's
// travel, as the host's own sidebars do, and moves land at most once a frame.
// Only the release commits, so a controlled parent re-renders once per drag.
function KitResizableSplit({
  first,
  second,
  orientation,
  sizedPane,
  "aria-label": ariaLabel,
  size,
  defaultSize,
  onSizeChange,
  minSize,
  maxSize,
  collapsible,
  collapsed,
  defaultCollapsed,
  onCollapsedChange,
  className,
  ...rest
}: PluginResizableSplitProps) {
  const paneId = useId();
  const horizontal = oneOf(orientation, ["horizontal", "vertical"] as const) !== "vertical";
  const sizedFirst = oneOf(sizedPane, ["first", "second"] as const) !== "second";
  const growKey = growKeyOf(horizontal, sizedFirst);
  const min = positive(minSize, SPLIT_LIMIT_PX) ?? SPLIT_MIN_PX;
  const max = Math.max(min, positive(maxSize, SPLIT_LIMIT_PX) ?? SPLIT_MAX_PX);
  const clamp = (value: number) => Math.min(Math.max(value, min), max);
  const resetSize = clamp(positive(defaultSize, SPLIT_LIMIT_PX) ?? SPLIT_DEFAULT_PX);
  const canCollapse = collapsible === true;
  const [ownSize, setOwnSize] = useState(resetSize);
  const [ownCollapsed, setOwnCollapsed] = useState(defaultCollapsed === true);
  const [drag, setDrag] = useState<SplitDrag | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const committedSize = clamp(positive(size, SPLIT_LIMIT_PX) ?? ownSize);
  const committedCollapsed =
    canCollapse && (typeof collapsed === "boolean" ? collapsed : ownCollapsed);
  const shownSize = drag ? drag.size : committedSize;
  const shownCollapsed = drag ? drag.collapsed : committedCollapsed;
  const handleSizeChange = fn(onSizeChange);
  const handleCollapsedChange = fn(onCollapsedChange);

  useEffect(() => () => cleanupRef.current?.(), []);

  const commit = (next: SplitDrag) => {
    if (next.collapsed !== committedCollapsed) {
      setOwnCollapsed(next.collapsed);
      handleCollapsedChange?.(next.collapsed);
    }
    if (!next.collapsed && next.size !== committedSize) {
      setOwnSize(next.size);
      handleSizeChange?.(next.size);
    }
  };

  const reset = () => commit({ size: resetSize, collapsed: false });

  const startDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    // The second press of a double-click is the reset, not a drag.
    if (event.button !== 0 || event.detail > 1) return;
    event.preventDefault();
    const origin = horizontal ? event.clientX : event.clientY;
    const startSize = committedCollapsed ? 0 : committedSize;
    let latest: SplitDrag | null = null;
    let frame = 0;
    let scheduled = false;
    const body = document.body.style;
    const previousCursor = body.cursor;
    const previousSelect = body.userSelect;
    body.cursor = horizontal ? "col-resize" : "row-resize";
    body.userSelect = "none";

    const move = (moveEvent: MouseEvent) => {
      // A release we never saw (outside the window, over an iframe) ends the drag.
      if (moveEvent.buttons === 0) {
        finish();
        return;
      }
      const travel = (horizontal ? moveEvent.clientX : moveEvent.clientY) - origin;
      const raw = startSize + (sizedFirst ? travel : -travel);
      latest =
        canCollapse && raw < min / 2
          ? { size: committedSize, collapsed: true }
          : { size: clamp(raw), collapsed: false };
      if (!scheduled) {
        scheduled = true;
        frame = requestAnimationFrame(() => {
          scheduled = false;
          setDrag(latest);
        });
      }
    };
    const cleanup = () => {
      if (scheduled) cancelAnimationFrame(frame);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", finish);
      body.cursor = previousCursor;
      body.userSelect = previousSelect;
      cleanupRef.current = null;
    };
    function finish() {
      cleanup();
      setDrag(null);
      if (latest) commit(latest);
    }
    cleanupRef.current?.();
    cleanupRef.current = cleanup;
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", finish);
    window.addEventListener("blur", finish);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (committedCollapsed && isShrinkKey(event.key, growKey)) {
      event.preventDefault();
      return;
    }
    const result = resolveSplitterKey(event, {
      growKey,
      value: committedCollapsed ? 0 : committedSize,
      min,
      max,
      step: SPLIT_STEP_PX,
      largeStep: SPLIT_LARGE_STEP_PX,
    });
    if (!result) return;
    event.preventDefault();
    if (result.kind === "set") {
      commit({ size: result.value, collapsed: false });
    } else if (canCollapse) {
      commit({ size: committedSize, collapsed: !committedCollapsed });
    } else {
      reset();
    }
  };

  const axis = horizontal ? "horizontal" : "vertical";
  const extent = horizontal ? "width" : "height";
  const sized = (
    <div
      id={paneId}
      data-split-pane="sized"
      style={
        shownCollapsed
          ? undefined
          : {
              [extent]: shownSize,
              [horizontal ? "maxWidth" : "maxHeight"]: `calc(100% - ${SPLIT_TRACK_PX[axis]}px)`,
            }
      }
      className={cn(
        "relative min-h-0 min-w-0 shrink-0 overflow-hidden",
        shownCollapsed ? "hidden" : "flex flex-col"
      )}
    >
      {node(sizedFirst ? first : second)}
    </div>
  );
  const other = (
    <div
      data-split-pane="fill"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {node(sizedFirst ? second : first)}
    </div>
  );
  return (
    <div
      {...pickRootProps(rest)}
      className={cn(
        "flex h-full min-h-0 w-full min-w-0",
        horizontal ? "flex-row" : "flex-col",
        str(className)
      )}
    >
      {sizedFirst ? sized : other}
      <ResizeHandle
        growKey={growKey}
        edge="inline"
        label={nonEmpty(ariaLabel) ?? "Resize pane"}
        value={shownCollapsed ? 0 : shownSize}
        min={canCollapse ? 0 : min}
        max={max}
        isResizing={drag !== null}
        aria-controls={paneId}
        aria-valuetext={shownCollapsed ? "Collapsed" : `${Math.round(shownSize)} pixels`}
        className="z-10"
        onMouseDown={startDrag}
        onKeyDown={handleKeyDown}
        onReset={reset}
      />
      {sizedFirst ? other : sized}
    </div>
  );
}

const HEADING_LEVELS = [2, 3, 4, 5, 6] as const;

function headingTag(level: unknown): "h2" | "h3" | "h4" | "h5" | "h6" {
  const found = HEADING_LEVELS.find((candidate) => candidate === level) ?? 3;
  return `h${found}`;
}

const DISCLOSURE_FOCUS_CLASS =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary";

function DisclosureHeader({
  level,
  triggerId,
  panelId,
  open,
  disabled,
  title,
  trailing,
  onToggle,
  className,
}: {
  level: unknown;
  triggerId: string;
  panelId: string;
  open: boolean;
  disabled: boolean;
  title: unknown;
  trailing: unknown;
  onToggle: () => void;
  className: string;
}) {
  const Heading = headingTag(level);
  return (
    <Heading className="m-0 flex min-w-0 text-sm font-medium">
      <button
        type="button"
        id={triggerId}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        data-disclosure-trigger=""
        onClick={onToggle}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] text-left text-text-primary",
          "transition-[background-color] duration-150 ease-out not-disabled:hover:bg-overlay-subtle",
          "disabled:cursor-not-allowed disabled:opacity-50",
          DISCLOSURE_FOCUS_CLASS,
          className
        )}
      >
        <ChevronRight
          data-animated-chevron
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform duration-150 ease-out",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 flex-1 truncate">{node(title)}</span>
        {hasContent(trailing) ? (
          <span className="flex shrink-0 items-center gap-1 text-xs font-normal text-text-secondary">
            {node(trailing)}
          </span>
        ) : null}
      </button>
    </Heading>
  );
}

interface AccordionEntry {
  value: string;
  title: unknown;
  content: unknown;
  trailing: unknown;
  disabled: boolean;
}

function readAccordionItems(items: unknown): AccordionEntry[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: AccordionEntry[] = [];
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = nonEmpty(field(entry, "value"));
    if (value === undefined || seen.has(value)) continue;
    seen.add(value);
    out.push({
      value,
      title: field(entry, "title"),
      content: field(entry, "content"),
      trailing: field(entry, "trailing"),
      disabled: field(entry, "disabled") === true,
    });
  }
  return out;
}

function readValues(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

/** Up/Down/Home/End between the enabled headers of one accordion, per the WAI-ARIA pattern. */
function moveBetweenHeaders(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.hasAttribute("data-disclosure-trigger")) return;
  const triggers = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      ":scope > [data-accordion-item] > * > [data-disclosure-trigger]:not(:disabled)"
    ),
  ];
  const index = triggers.findIndex((trigger) => trigger === target);
  if (index === -1) return;
  let next: number;
  switch (event.key) {
    case "ArrowDown":
      next = (index + 1) % triggers.length;
      break;
    case "ArrowUp":
      next = (index - 1 + triggers.length) % triggers.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = triggers.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  triggers[next]?.focus();
}

function KitAccordion({
  items,
  type,
  value,
  defaultValue,
  onValueChange,
  headingLevel,
  className,
  ...rest
}: PluginAccordionProps) {
  const baseId = useId();
  const entries = readAccordionItems(items);
  const single = oneOf(type, ["single", "multiple"] as const) !== "multiple";
  const [ownValue, setOwnValue] = useState<string[]>(() => readValues(defaultValue) ?? []);
  const controlled = readValues(value);
  const open = controlled ?? ownValue;
  const handleChange = fn(onValueChange);
  const toggle = (itemValue: string) => {
    const isOpen = open.includes(itemValue);
    const next = isOpen
      ? open.filter((entry) => entry !== itemValue)
      : single
        ? [itemValue]
        : [...open, itemValue];
    setOwnValue(next);
    handleChange?.(next);
  };
  return (
    <div
      {...pickRootProps(rest)}
      onKeyDown={moveBetweenHeaders}
      className={cn("flex min-w-0 flex-col divide-y divide-border-subtle", str(className))}
    >
      {entries.map((entry, index) => {
        const isOpen = open.includes(entry.value);
        // By position: a value is plugin text and need not be a valid id.
        const triggerId = `${baseId}trigger-${index}`;
        const panelId = `${baseId}panel-${index}`;
        return (
          <div key={entry.value} data-accordion-item="" data-state={isOpen ? "open" : "closed"}>
            <DisclosureHeader
              level={headingLevel}
              triggerId={triggerId}
              panelId={panelId}
              open={isOpen}
              disabled={entry.disabled}
              title={entry.title}
              trailing={entry.trailing}
              onToggle={() => toggle(entry.value)}
              className="px-3 py-2.5"
            />
            {isOpen ? (
              <div
                role="region"
                id={panelId}
                aria-labelledby={triggerId}
                className="min-w-0 pb-3 pl-8.5 pr-3 text-sm"
              >
                <InsetSurface>{node(entry.content)}</InsetSurface>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function KitDisclosure({
  title,
  children,
  open,
  defaultOpen,
  onOpenChange,
  trailing,
  disabled,
  headingLevel,
  className,
  ...rest
}: PluginDisclosureProps) {
  const baseId = useId();
  const [ownOpen, setOwnOpen] = useState(defaultOpen === true);
  const isOpen = typeof open === "boolean" ? open : ownOpen;
  const handleChange = fn(onOpenChange);
  const triggerId = `${baseId}trigger`;
  const panelId = `${baseId}panel`;
  return (
    <div
      {...pickRootProps(rest)}
      data-state={isOpen ? "open" : "closed"}
      className={cn("flex min-w-0 flex-col", str(className))}
    >
      <DisclosureHeader
        level={headingLevel}
        triggerId={triggerId}
        panelId={panelId}
        open={isOpen}
        disabled={disabled === true}
        title={title}
        trailing={trailing}
        onToggle={() => {
          setOwnOpen(!isOpen);
          handleChange?.(!isOpen);
        }}
        // The glyph sits on the content's edge; the hover wash reaches past it.
        className="-mx-1.5 w-[calc(100%+0.75rem)] px-1.5 py-1.5"
      />
      {isOpen ? (
        <div
          role="region"
          id={panelId}
          aria-labelledby={triggerId}
          className="min-w-0 pb-1 pl-5.5 pt-1 text-sm"
        >
          {node(children)}
        </div>
      ) : null}
    </div>
  );
}

interface DescriptionListSettings {
  layout: "inline" | "stacked";
  copyable: boolean;
}

const DescriptionListContext = createContext<DescriptionListSettings>({
  layout: "inline",
  copyable: false,
});

function copyTextOf(item: PluginDescriptionItem, copyable: boolean): string | undefined {
  const explicit = nonEmpty(item.copyText);
  if (explicit !== undefined) return explicit;
  if (!copyable) return undefined;
  const value: unknown = item.value;
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function DescriptionRow({
  item,
  root,
  className,
}: {
  item: PluginDescriptionItem;
  root: Record<string, string | number | boolean>;
  className?: string;
}) {
  const { layout, copyable } = useContext(DescriptionListContext);
  const inline = layout === "inline";
  const copyText = copyTextOf(item, copyable);
  const label: unknown = item.label;
  return (
    <div
      {...root}
      className={cn(
        inline
          ? "col-span-2 grid grid-cols-subgrid items-baseline"
          : "flex min-w-0 flex-col gap-0.5",
        className
      )}
    >
      <dt className={cn("min-w-0 break-words text-text-secondary", inline ? "text-sm" : "text-xs")}>
        {node(label)}
      </dt>
      <dd className="m-0 flex min-w-0 items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="break-words text-sm text-text-primary select-text">
            {hasContent(item.value) ? (
              node(item.value)
            ) : (
              <>
                <span aria-hidden="true" className="text-text-secondary">
                  —
                </span>
                <span className="sr-only">None</span>
              </>
            )}
          </div>
          {hasContent(item.hint) ? (
            <div className="mt-0.5 text-xs text-text-secondary">{node(item.hint)}</div>
          ) : null}
        </div>
        {copyText !== undefined ? (
          <CopyButton
            text={copyText}
            size="icon-xs"
            aria-label={typeof label === "string" && label !== "" ? `Copy ${label}` : "Copy value"}
            className="-my-0.5 shrink-0"
          />
        ) : null}
      </dd>
    </div>
  );
}

function readDescriptionItem(entry: unknown): PluginDescriptionItem | null {
  if (typeof entry !== "object" || entry === null) return null;
  return {
    label: node(field(entry, "label")),
    value: node(field(entry, "value")),
    hint: node(field(entry, "hint")),
    copyText: str(field(entry, "copyText")),
  };
}

function KitDescriptionList({
  items,
  children,
  layout,
  copyable,
  className,
  ...rest
}: PluginDescriptionListProps) {
  const settings: DescriptionListSettings = {
    layout: oneOf(layout, ["inline", "stacked"] as const) ?? "inline",
    copyable: copyable === true,
  };
  const rows = Array.isArray(items)
    ? items.map(readDescriptionItem).filter((item) => item !== null)
    : [];
  return (
    <DescriptionListContext value={settings}>
      <dl
        {...pickRootProps(rest)}
        className={cn(
          "m-0 min-w-0",
          settings.layout === "inline"
            ? "grid grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-6 gap-y-2.5"
            : "flex flex-col gap-3",
          str(className)
        )}
      >
        {rows.map((item, index) => (
          <DescriptionRow key={index} item={item} root={{}} />
        ))}
        {node(children)}
      </dl>
    </DescriptionListContext>
  );
}

function KitDescriptionListItem({
  label,
  value,
  hint,
  copyText,
  className,
  ...rest
}: PluginDescriptionListItemProps) {
  const item = readDescriptionItem({ label, value, hint, copyText });
  if (!item) return null;
  return <DescriptionRow item={item} root={pickRootProps(rest)} className={str(className)} />;
}

export const pluginKitLayout = {
  Card: KitCard,
  Divider: KitDivider,
  SectionLabel: KitSectionLabel,
  ResizableSplit: KitResizableSplit,
  Accordion: KitAccordion,
  Disclosure: KitDisclosure,
  DescriptionList: KitDescriptionList,
  DescriptionListItem: KitDescriptionListItem,
};
