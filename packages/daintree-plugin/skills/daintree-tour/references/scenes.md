# Scenes

Each chapter's scene is a zero-prop React component that draws a stylized mock of the plugin on the tour's fixed 640×360 canvas. The tour dialog supplies the canvas, scaling, theme and player — a scene just renders absolutely positioned content inside it. Don't wrap scenes in `TourCanvas`.

Never use a screenshot, screen recording, exported image, or `<img>`/`<video>` of the real UI. Everything is drawn from Daintree's design tokens, so the scene follows the viewer's theme.

## Imports

| From | What |
| --- | --- |
| `@daintreehq/tour/react` | `useCue(id, offset?)` — true once the cue (plus `offset` seconds) has passed. `useSecondsSinceCue(id)` — seconds since the cue, or `null` before it. `useTimelineIndex(points)` — index of the last `{ cue, offset? }` reached. |
| `@daintreehq/tour/kit` | `reveal(visible, from?)` — the standard enter/exit classes. `MockLines`, `MockStreamingLines` — grey placeholder lines for text the viewer needn't read. `MockTyping` — text typed from a cue. `MockCursor` + `useMockCursor` — a scripted pointer that glides to anchors and clicks. `MockSpotlight` — dims the scene around named anchors. `MockCallout`, `MockTooltip`, `MockKeys`, `MockMenu`, `MockPanel`, `MockSearchField`, `MockLegend`. `cn` — class joiner. `TOUR_CANVAS` — `{ width: 640, height: 360 }`. |
| `@daintreehq/tour/mock-app` | `MockApp` — the Daintree window shell (toolbar, sidebar, grid, dock), `MockGrid`, `MockEmptyGrid`, `MockWorktreeCard`. Useful for a panel tour that shows the panel in place. |

Read the exact props from the installed types before using a component: `node_modules/@daintreehq/tour/dist/kit.d.ts`, `react.d.ts`, `mock-app.d.ts`. Don't guess a prop name.

The built-in scenes are the reference for how these are used together: <https://github.com/daintreehq/daintree/tree/develop/src/components/Tour/scenes> (`WelcomeScene.tsx`, `WorktreesScene.tsx` and `FilesScene.tsx` are good starting points). If you can fetch them, read two before writing the first scene.

## Anchors

Mark every element the narration points at with `data-tour-anchor="name"`. `MockSpotlight targets`, `MockCursor` steps (`{ anchor: "name" }`) and the preview's capture all find elements by anchor and measure them from the render, so highlights and clicks stay on target however the layout shifts. Never hand-place a highlight or cursor over an element with coordinates.

## The style

Daintree's scenes are quiet and sparse. The frame should read in the second or two the viewer looks at it.

**Layout.** One subject per scene, centred or anchored where it lives in the real UI, with generous empty space. A panel mock is usually 300–460px wide inside the 640×360 canvas. Show only what the chapter's narration mentions plus just enough context to place it; drop every control nobody talks about.

**Density.** Real words only for things the narration names or the viewer must read (a button label, a panel title, a typed value). Everything else is `MockLines` bars. Three to six items in a list, not twenty.

**Type.** Small and even: `text-3xs` and `text-2xs` for UI text, `text-xs font-semibold` for a dialog or panel heading at most. `font-medium` for labels, never bold body text.

**Colour.** Semantic token classes only, never hex, rgb, or Tailwind palette colours (`bg-blue-500`):

- Surfaces: `bg-surface-canvas` (the backdrop), `bg-surface-panel`, `bg-surface-panel-elevated`, `bg-surface-dialog`, `bg-surface-input`, `bg-surface-toolbar`, `bg-surface-sidebar`.
- Text: `text-text-primary`, `text-text-secondary`, `text-text-inverse` (on a `bg-text-primary` button).
- Borders: `border-border-subtle`, `border-border-default`, `border-border-strong`, `border-border-input`, `border-border-interactive` (focus).
- Shadow: `shadow-[var(--theme-shadow-ambient)]` on floating things (dialogs, menus).
- Accent: at most one accent per scene, for the one thing that matters, from the `category-*` family (`text-category-amber-text`, `bg-category-amber-subtle`). In doubt, no accent. A primary button is `bg-text-primary text-text-inverse`, not a coloured one.

Rounded corners `rounded-md` for controls, `rounded-lg` for panels and dialogs.

**Motion.** Things appear on cues with `reveal(visible)` (a 200ms fade and small lift) or `reveal(visible, "left")` for things sliding in from the side — no custom keyframes, bounces, spins or long transitions. Stagger a group with `transitionDelay` of roughly 100–150ms. A pointer glides with `MockCursor`, text types with `MockTyping`, output streams with `MockStreamingLines`. A scene moves only when the narration gives it a reason; between cues it holds still. Use `MockSpotlight` to direct the eye, not colour changes or pulsing.

**Timing.** Every change the narration talks about is gated on `useCue`. A small follow-on beat can use an offset (`useCue("open", 0.6)`), never a `setTimeout` or `setInterval`.

## A complete scene

```tsx
import { cn, MockLines, MockSpotlight, reveal } from "@daintreehq/tour/kit";
import { useCue } from "@daintreehq/tour/react";

const PAGES = ["Home", "Pricing", "Blog"];

// "This is the Acme site builder. [[pages]] Every page you add shows up in
// this list, and [[preview]] the preview on the right updates as you type."
export function IntroScene() {
  const pages = useCue("pages");
  const preview = useCue("preview");

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-surface-canvas">
      <div className="flex h-[220px] w-[440px] overflow-hidden rounded-lg border border-border-default bg-surface-panel shadow-[var(--theme-shadow-ambient)]">
        <div
          data-tour-anchor="page-list"
          className="flex w-[130px] flex-col gap-1 border-r border-border-subtle p-2"
        >
          <span className="mb-1 text-2xs font-medium text-text-secondary">Pages</span>
          {PAGES.map((page, i) => (
            <span
              key={page}
              className={cn(
                "rounded-md px-1.5 py-1 text-3xs text-text-primary",
                i === 0 && "bg-surface-panel-elevated",
                reveal(pages)
              )}
              style={{ transitionDelay: pages ? `${i * 120}ms` : undefined }}
            >
              {page}
            </span>
          ))}
        </div>
        <div data-tour-anchor="preview" className="flex flex-1 flex-col gap-3 p-4">
          <div className="text-xs font-semibold text-text-primary">Home</div>
          <MockLines widths={[88, 72, 94, 60]} className={reveal(preview)} />
        </div>
      </div>
      <MockSpotlight targets={preview ? ["preview"] : ["page-list"]} visible={pages} />
    </div>
  );
}
```

Width percentages in `MockLines` are per line (0–100). Keep line counts and widths varied so the bars read as text.

## Check a scene against its narration

For each chapter, before building:

- Every `[[cue]]` in the narration is read by exactly the scene for that chapter, and the scene reads no cue the narration doesn't mark (`tour preview` warns about the second).
- The thing a cue's word names is what visibly changes at that cue.
- Nothing on screen contradicts the narration (a button the narration calls "Publish" is labelled "Publish").
