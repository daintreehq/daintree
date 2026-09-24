import { useId, useLayoutEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/** The empty grid, as a new worktree shows it: the launcher and nothing else. */
export function MockEmptyGrid({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn("flex size-full flex-col items-center justify-center gap-2", className)}>
      <span className="text-xs font-semibold text-text-primary">{label}</span>
      <span className="flex h-6 w-48 items-center gap-1.5 rounded-md border border-border-default bg-surface-panel px-2">
        <Search className="size-3 text-text-secondary" aria-hidden="true" />
        <span className="text-3xs text-text-placeholder">Search agents &amp; panels…</span>
      </span>
    </div>
  );
}

/** A small label that names what a glyph means, pinned beside it on the canvas. */
export function MockCallout({
  x,
  y,
  visible,
  children,
}: {
  x: number;
  y: number;
  visible: boolean;
  children: string;
}) {
  return (
    <span
      className={cn(
        "absolute z-10 -translate-x-full whitespace-nowrap rounded-md border border-border-strong bg-surface-panel-elevated px-1.5 py-0.5 text-3xs font-medium text-text-primary shadow-[var(--theme-shadow-ambient)]",
        "transition-opacity duration-200 ease-out",
        visible ? "opacity-100" : "opacity-0"
      )}
      style={{ left: x, top: y }}
    >
      {children}
    </span>
  );
}

interface Hole {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SPOTLIGHT_PAD = 3;
// Re-measure once the target's own entry transition (200ms) has settled.
const SETTLE_MS = 260;

/** Canvas-space rectangles of the named `data-tour-anchor` elements. */
function measureAnchors(from: Element, targets: readonly string[]): Hole[] {
  const canvas = from.closest<HTMLElement>("[data-tour-canvas]");
  if (!canvas || canvas.offsetWidth === 0) return [];
  const box = canvas.getBoundingClientRect();
  const scale = box.width / canvas.offsetWidth;
  return targets.flatMap((target) => {
    const el = canvas.querySelector(`[data-tour-anchor="${target}"]`);
    if (!el) return [];
    const r = el.getBoundingClientRect();
    return [
      {
        x: (r.left - box.left) / scale - SPOTLIGHT_PAD,
        y: (r.top - box.top) / scale - SPOTLIGHT_PAD,
        width: r.width / scale + SPOTLIGHT_PAD * 2,
        height: r.height / scale + SPOTLIGHT_PAD * 2,
      },
    ];
  });
}

/**
 * "Look here": the scene dims slightly and the named elements stay at full
 * brightness with a soft ring. Targets are `data-tour-anchor` names measured
 * from the render, never hand-placed coordinates, so the highlight always
 * lands on the element it names however the mockup's layout shifts.
 */
export function MockSpotlight({
  targets,
  visible,
}: {
  targets: readonly string[];
  visible: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [holes, setHoles] = useState<Hole[]>([]);
  const key = targets.join("|");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !visible) return;
    const names = key.split("|").filter(Boolean);
    const measure = () => setHoles(measureAnchors(el, names));
    measure();
    const timer = window.setTimeout(measure, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [key, visible]);

  const maskId = useId();
  return (
    <svg
      ref={ref}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 z-[15] size-full transition-opacity duration-200 ease-out",
        visible && holes.length > 0 ? "opacity-100" : "opacity-0"
      )}
    >
      <defs>
        <mask id={maskId}>
          <rect width="100%" height="100%" fill="white" />
          {holes.map((hole, i) => (
            <rect key={i} {...hole} rx="7" fill="black" />
          ))}
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="black" opacity="0.28" mask={`url(#${maskId})`} />
      {holes.map((hole, i) => (
        <rect
          key={i}
          {...hole}
          rx="7"
          fill="none"
          strokeWidth="1.5"
          className="stroke-text-primary"
          opacity="0.55"
        />
      ))}
    </svg>
  );
}

export interface LegendItem {
  glyph: React.ReactNode;
  label: string;
  active: boolean;
}

/** A strip of glyph-and-word pairs along the bottom of the stage; the one being narrated lights up. */
export function MockLegend({
  items,
  visible,
  bottom,
}: {
  items: readonly LegendItem[];
  visible: boolean;
  bottom: number;
}) {
  return (
    <div
      className={cn(
        "absolute inset-x-0 z-10 flex justify-center transition-opacity duration-200 ease-out",
        visible ? "opacity-100" : "opacity-0"
      )}
      style={{ bottom }}
    >
      <div className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface-panel-elevated p-1 shadow-[var(--theme-shadow-ambient)]">
        {items.map((item) => (
          <span
            key={item.label}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 transition-[background-color,opacity] duration-150 ease-out",
              item.active ? "bg-overlay-selected opacity-100" : "opacity-50"
            )}
          >
            {item.glyph}
            <span className="text-2xs font-medium text-text-primary">{item.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** A non-agent panel (file browser, dev preview): icon, title, then its own body. */
export function MockPanel({
  icon,
  title,
  focused,
  toolbar,
  children,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  focused?: boolean;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border bg-surface-panel transition-[border-color] duration-150 ease-out",
        focused ? "border-border-interactive" : "border-border-default",
        className
      )}
    >
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-surface-panel-elevated px-2 text-text-secondary [&_svg]:size-3">
        {icon}
        <span className="truncate text-2xs font-medium text-text-primary">{title}</span>
      </div>
      {toolbar}
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** A keystroke shown on screen, for chapters that teach a shortcut. */
export function MockKeys({
  keys,
  x,
  y,
  visible,
}: {
  keys: readonly string[];
  x: number;
  y: number;
  visible: boolean;
}) {
  return (
    <span
      className={cn(
        "absolute z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-lg border border-border-strong bg-surface-panel-elevated px-2 py-1.5 shadow-[var(--theme-shadow-ambient)]",
        "transition-opacity duration-200 ease-out",
        visible ? "opacity-100" : "opacity-0"
      )}
      style={{ left: x, top: y }}
    >
      {keys.map((key) => (
        <kbd
          key={key}
          className="min-w-5 rounded-sm border border-border-strong bg-surface-panel px-1.5 py-0.5 text-center font-sans text-xs font-medium text-text-primary"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

export interface MockMenuItem {
  icon?: React.ReactNode;
  label: string;
  hint?: string;
}

/** A dropdown or palette list; `active` marks the row the pointer or keyboard is on. */
export function MockMenu({
  items,
  active,
  visible,
  x,
  y,
  width,
  header,
}: {
  items: readonly MockMenuItem[];
  active: number;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  header?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "absolute z-20 rounded-lg border border-border-strong bg-surface-panel-elevated p-1 shadow-[var(--theme-shadow-ambient)]",
        "transition-opacity duration-150 ease-out",
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      )}
      style={{ left: x, top: y, width }}
    >
      {header}
      {items.map((item, i) => (
        <div
          key={item.label}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1 text-3xs transition-colors duration-150 ease-out [&_svg]:size-3",
            i === active ? "bg-overlay-selected text-text-primary" : "text-text-secondary"
          )}
        >
          {item.icon}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.hint && <span className="shrink-0 text-text-secondary">{item.hint}</span>}
        </div>
      ))}
    </div>
  );
}

/** A search field row, as palettes and dropdowns open with. */
export function MockSearchField({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 flex h-5 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border border-border-subtle bg-surface-input px-1.5 text-3xs">
      <Search className="size-2.5 shrink-0 text-text-secondary" aria-hidden="true" />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}
