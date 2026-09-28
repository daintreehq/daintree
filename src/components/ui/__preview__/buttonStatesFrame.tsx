import type { ReactNode } from "react";

/**
 * Shared chrome for the button-states harness. None of this is product UI: a
 * captioned block is how a reviewer knows which shipped component, at which
 * file, a strip of pixels belongs to when several are stacked in one capture.
 */

export interface Fixture {
  /** What a reviewer should see, and which call sites it covers. */
  what: string;
  /** CSS px width of the surface; the capture is of the surface, not the viewport. */
  width?: number;
  /** Runs once before the first render — store seeding lives here, never in a body. */
  seed?: () => void;
  render: () => ReactNode;
}

export function Block({
  caption,
  children,
  surface = "panel",
  pad = true,
}: {
  caption: string;
  children: ReactNode;
  /** Which app surface the component normally sits on. */
  surface?: "panel" | "sidebar" | "canvas" | "elevated";
  pad?: boolean;
}) {
  const bg =
    surface === "sidebar"
      ? "bg-surface-sidebar"
      : surface === "canvas"
        ? "bg-surface-canvas"
        : surface === "elevated"
          ? "bg-surface-panel-elevated"
          : "bg-surface-panel";
  return (
    <section data-preview-block className="flex flex-col gap-1.5">
      <p
        data-harness-decoration
        className="font-mono text-3xs uppercase tracking-wider text-text-muted"
      >
        {caption}
      </p>
      <div className={`rounded-[var(--radius-md)] border border-divider ${bg} ${pad ? "p-3" : ""}`}>
        {children}
      </div>
    </section>
  );
}

export const noop = () => undefined;
export const noopAsync = () => Promise.resolve();
export const never = () => new Promise<never>(() => undefined);

/**
 * The one place this harness narrows a type it cannot construct in full — a
 * partial availability map, a plugin record, an action id outside the typed
 * registry. Fixtures are inert data; nothing here reaches product code.
 */
export function fixture<T>(value: unknown): T {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert harness fixture
  return value as T;
}
