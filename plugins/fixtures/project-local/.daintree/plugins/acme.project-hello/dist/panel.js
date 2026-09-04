/**
 * Built panel view for the `main` view contribution.
 *
 * Hand-written browser ESM with no build step — the shape a project-local
 * plugin (or an agent writing one) actually produces. It doubles as the
 * acceptance fixture for the Tailwind styling contract (#12220), so it uses
 * only utility classes and no `<style>` element or CSS file of its own:
 *
 *   - `bg-surface-panel`, `text-text-muted`, `border-border-subtle` are the
 *     host's semantic tokens, so this panel follows a theme switch with no
 *     recompile.
 *   - `hover:bg-surface-hover` proves variants compile.
 *   - `w-[327px]` proves arbitrary values do.
 *   - `bg-red-500` deliberately generates NOTHING: the host's design contract
 *     resets the stock palette, and the diagnostics action reports this class
 *     under `notGenerated`. It is here so that behaviour is observable.
 *   - The expanded row is mounted on a state toggle, so its classes are first
 *     seen after mount — the DOM-observer half of candidate discovery.
 *
 * React is externalised in a real build and served by the host import map; a
 * raw view like this one imports it directly, which is the only bare specifier
 * available without a bundler.
 */
import { createElement as h, useState } from "react";

export default function Panel({ pluginId }) {
  const [expanded, setExpanded] = useState(false);

  return h(
    "div",
    { className: "flex flex-col gap-2 p-4 bg-surface-panel text-text-primary" },
    h("h1", { className: "text-sm font-medium" }, "Project Hello"),
    h(
      "p",
      { className: "text-2xs text-text-muted" },
      // A class that generates no CSS. The text stays legible because the
      // surrounding rules do compile — which is exactly the "half styled with
      // no error anywhere" failure the diagnostics report exists to surface.
      h("span", { className: "bg-red-500" }, pluginId)
    ),
    h(
      "button",
      {
        type: "button",
        onClick: () => setExpanded((value) => !value),
        className:
          "w-[327px] rounded-md border border-border-subtle px-3 py-2 text-left " +
          "hover:bg-surface-hover",
      },
      expanded ? "Hide details" : "Show details"
    ),
    expanded
      ? h(
          "div",
          { className: "rounded-md bg-surface-inset p-4 text-2xs text-text-muted" },
          "Styled by the host's Tailwind at runtime — these classes were first seen after mount."
        )
      : null
  );
}
