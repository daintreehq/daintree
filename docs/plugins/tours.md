# Tours

A plugin can ship a narrated welcome tour that plays in the same dialog as the Daintree Tour: a few short chapters, each a minimal animated mockup of one idea with a voice-over and captions. This guide covers the whole path, from the manifest entry to a voiced, previewed tour, and the house style every tour is held to.

For the manifest field table on its own, see [Contribution points → Tours](./contribution-points.md#tours--shipped-installed-plugins).

## Two shapes

|  | Plugin tour | Panel tour |
| --- | --- | --- |
| Declared by | A `contributes.tours` entry without `panelKind` | A `contributes.tours` entry whose `panelKind` names one of this plugin's own `contributes.panels` |
| Offered from | Help and the command palette, as the plugin's display name and the tour's title ("Acme Site Builder: Welcome Tour") | That panel's three-dots and right-click menus, as the panel's name followed by "Welcome Tour" ("Site Builder Welcome Tour") |
| Length | As many chapters as the story needs, up to 32 | A couple of chapters |
| Wiring in your code | None | None — the menu item appears once the tour registers and disappears when it is withdrawn |

Both are the same contribution, validated and played the same way. If two tours name the same panel, the first wins. Tours are available to installed plugins only; a manifest with `"scope": "project"` that declares one is refused.

## The standard

A user moving from the Daintree Tour to your tour should not be able to tell a different author made it. That holds for a two-chapter panel tour as much as for a full plugin tour.

- **Stylized animated mocks, built from the kit.** Draw every scene with `@daintreehq/tour/kit` and `@daintreehq/tour/mock-app`, styled only with the theme's tokens. No screenshots, no screen recordings, no images of the real UI, no one-off visual language. A mock follows the viewer's theme, light or dark, with no assets; a screenshot can't.
- **Deliberately low fidelity.** The real window is right behind the dialog. A scene shows the shape of the idea: grey lines for text (`MockLines`), a card for a worktree, a pane for a terminal. Label only what the narration names.
- **One idea per chapter.** A chapter makes one point in one or two sentences a listener can hold. If you find yourself explaining a second thing, that's the next chapter.
- **Dim what the chapter isn't about.** Keep the whole window on screen so the viewer's map stays intact, and recede everything else: `MockApp`'s `focus` keeps the regions you name at full strength and fades the rest, and `MockSpotlight` rings the exact elements the narration is pointing at.
- **Motion follows the narration.** Nothing moves on its own clock. Every reveal, cursor move, click and typed prompt fires on a `[[cue]]` the narrator speaks, so re-voicing re-times the whole scene. Motion is the kit's short CSS transitions (`reveal`), never a custom animation.
- **Your panel is drawn the same way.** A panel tour shows your panel as a `MockPane` or a plain token-styled box inside the mock window's grid, at the same fidelity as everything around it.

The built-in scenes in `src/components/Tour/scenes/` are the reference for what this looks like; `WorktreesScene.tsx` is a good one to read first.

## Files

```
my-plugin/
├── plugin.json                    # contributes.tours: the entry and its generated timing
├── src/tour.tsx                   # your scenes (built to dist/tour.js)
├── dist/tour.js                   # componentPath: the scene module Daintree imports
├── tours/
│   ├── welcome.narration.json     # the narration you write
│   └── welcome/                   # audio written by `daintree-plugin tour voice` / `align`
│       ├── intro.simon.1a2b3c4d5e6f.ogg
│       └── publish.simon.9f8e7d6c5b4a.ogg
└── .dntrignore                    # keep the narration file and raw recordings out of the package
```

| Piece | You write it | What it holds |
| --- | --- | --- |
| `contributes.tours[]` in `plugin.json` | The `id`, `title`, `componentPath`, `panelKind`, `audioHosts` | The CLI fills in `chapters`: each chapter's duration, cue times, captions, `audioUrl` and `narrationHash`, in narration order. You don't write chapter timing by hand. |
| `tours/<tourId>.narration.json` | Yes | The spoken text of every chapter, with `[[cue]]` markers. The source of truth for the timing. |
| The scene module | Yes | One React component per chapter id, plus optional chapter titles and mock-kit data. |
| `tours/<tourId>/*.ogg` | No | Ogg Opus narration, named `<chapter>.<variant>.<hash>.ogg` (the variant is the voice, or `recorded` for your own takes), so a new take never overwrites the one an older build plays. |

## A minimal tour

A two-chapter plugin tour. Copy it, rename the ids, and run it through [Voicing](#voicing) and [Previewing](#previewing-and-testing).

**`plugin.json`** — declare the tour with an empty `chapters` array. `daintree-plugin validate` refuses a tour with no chapters until the first `tour voice` or `tour align` fills them in.

```json
{
  "name": "acme.site-builder",
  "version": "0.1.0",
  "displayName": "Acme Site Builder",
  "engines": { "daintree": ">=0.38.0" },
  "contributes": {
    "tours": [
      {
        "id": "welcome",
        "title": "Welcome Tour",
        "componentPath": "dist/tour.js",
        "chapters": []
      }
    ]
  }
}
```

**`tours/welcome.narration.json`** — the words, in chapter order.

```json
{
  "chapters": [
    {
      "id": "intro",
      "narration": "This is the Acme site builder. Every [[pages]] page you add shows up here, next to the agents working on it."
    },
    {
      "id": "publish",
      "narration": "When a page is ready, [[publish]] publish it from the same panel."
    }
  ]
}
```

**`src/tour.tsx`** — one scene per chapter, drawn inside the mock Daintree window.

```tsx
import { MockLines, MockSpotlight, reveal } from "@daintreehq/tour/kit";
import { MockApp, MockGrid, MockPane, MockWorktreeCard } from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";

const PAGES = ["Home", "Pricing", "Blog"];

function Worktrees() {
  return <MockWorktreeCard name="acme-site" branch="main" selected states={["working"]} />;
}

function Pages({ shown }: { shown: boolean }) {
  return (
    <div className="flex h-full flex-col gap-1.5 rounded-lg border border-border-default bg-surface-panel p-2.5">
      <div className="text-2xs font-semibold text-text-primary">Site Builder</div>
      <ul className={reveal(shown)} data-tour-anchor="acme-pages">
        {PAGES.map((page) => (
          <li key={page} className="rounded-md px-1.5 py-1 text-2xs text-text-secondary">
            {page}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Intro() {
  const pages = useCue("pages");
  return (
    <MockApp
      focus={pages ? ["grid"] : undefined}
      worktrees={<Worktrees />}
      grid={
        <MockGrid columns={2}>
          <Pages shown={pages} />
          <MockPane agent="claude" state="working">
            <MockLines widths={[84, 62, 90, 50]} />
          </MockPane>
        </MockGrid>
      }
    >
      <MockSpotlight targets={["acme-pages"]} visible={pages} />
    </MockApp>
  );
}

function Publish() {
  const published = useCue("publish");
  return (
    <MockApp
      focus={["grid"]}
      worktrees={<Worktrees />}
      grid={
        <MockGrid columns={1}>
          <div className="flex h-full items-center justify-center rounded-lg border border-border-default bg-surface-panel">
            <span
              data-tour-anchor="acme-publish"
              className={
                published
                  ? "rounded-md bg-category-teal-subtle px-3 py-1.5 text-xs text-category-teal-text"
                  : "rounded-md bg-surface-panel-elevated px-3 py-1.5 text-xs text-text-secondary"
              }
            >
              {published ? "Published" : "Publish"}
            </span>
          </div>
        </MockGrid>
      }
    />
  );
}

export default {
  scenes: { intro: Intro, publish: Publish },
  chapterTitles: { intro: "Build your pages", publish: "Go live" },
};
```

**`vite.config.ts`** — build it with `@daintreehq/plugin-vite`, which leaves `react` and `@daintreehq/tour` external for the host to supply. Install `@daintreehq/tour` as a dev dependency for its types and for `tour preview`.

```ts
import { daintreePlugin } from "@daintreehq/plugin-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [daintreePlugin()],
  build: { lib: { entry: { tour: "src/tour.tsx" }, formats: ["es"] } },
});
```

Then build, voice, and preview:

```bash
npm run build
INWORLD_API_KEY=… npx daintree-plugin tour voice
npx daintree-plugin tour preview
```

To make it a panel tour instead, add `"panelKind": "<your panel id>"` to the entry and keep it to a chapter or two about that panel.

A scene module doesn't need a build step. `plugins/fixtures/installed/acme.welcome-tour/` in the Daintree repo is a test fixture whose `dist/tour.js` is hand-written ESM with `createElement`: bare `react` and `@daintreehq/tour/*` imports resolve through the host import map exactly as they do in a raw view. Copy its wiring, not its scenes, which are deliberately bare and not drawn in the mock window.

## Writing narration

Narration is written for the ear, and the same rules apply to plugin tours as to the Daintree Tour (they live in the header of `src/components/Tour/tourChapters.ts`).

- **`[[cue]]` sits immediately before the word the scene reacts to.** `Every [[pages]] page you add` fires `pages` the moment "page" is spoken. The marker is never voiced. Cue ids are yours to name; each one becomes a key in the chapter's `cues`.
- **Write for the ear.** No symbols, no abbreviations the voice has to guess at, no file paths read aloud. Short sentences. Say "command palette", not "⌘⇧P".
- **Spell shortcuts out in words.** Plugin narration has one take per chapter; the `{{action.id}}` shortcut tokens the Daintree Tour voices once per keyboard are not expanded for plugin tours. Prefer naming the command over naming its keys.
- **`[single brackets]` direct the delivery, never the content.** Write them as short stage directions that combine two dimensions (`[warm and welcoming, unhurried]` reads better than `[warm]`), put them at the start of a sentence, and use them sparingly: a direction holds until the next one, and every switch is an audible change of register. The plain read is usually the right one.
- **A chapter is a sentence or two.** Most built-in chapters run 10 to 20 seconds. A chapter can be at most 600 seconds, but a viewer won't sit through anything close.

Editing a chapter's words or directions changes its fingerprint, which marks that chapter's timing stale until it is re-voiced (`tour preview` warns about it). Re-running `tour voice` only re-voices the chapters whose narration or voice changed.

## Building scenes

### The scene module

`componentPath` is imported only when the tour opens, never at startup. It must default-export an object:

| Key | Required | Notes |
| --- | --- | --- |
| `scenes` | yes | `{ [chapterId]: Component }`. Every chapter in the manifest needs one. Scenes take no props. |
| `chapterTitles` | no | `{ [chapterId]: string }`, shown above the scene. A chapter without one is titled by its id. |
| `mockKit` | no | The agents, state glyphs and CI marks the mock window draws. See [The mock Daintree window](#the-mock-daintree-window). |

A module that fails to import, takes longer than 10 seconds to load, or is missing a scene opens nothing and tells the user. Each scene renders inside your plugin's style root, so its Tailwind classes compile scoped exactly as they do in a plugin view, and the design contract's tokens (`category-*` included) are available for anything you draw beside the kit's parts. See [Views](./views.md) for the token vocabulary.

Scenes are drawn on a fixed 640×360 canvas (`TOUR_CANVAS`) that the dialog scales to fit, so author in canvas pixels. The canvas is `aria-hidden`: the chapter title and captions carry the content for assistive technology.

### Reading the timeline

From `@daintreehq/tour/react`. The host import map resolves it to the host's own player, which is why it must stay external to your bundle.

| Hook | Use |
| --- | --- |
| `useCue(id, offset?)` | `true` once the timeline passes cue `id` (plus `offset` seconds). Re-renders only on the boundary; the motion itself is CSS. A cue the narration never marks never fires, so the scene stays inert rather than broken. The workhorse. |
| `useTimelineIndex(points)` | Index of the latest `{ cue, offset? }` point passed, or -1. `points` must be declared at module scope. |
| `useSecondsSinceCue(id)` | Seconds since a cue, or `null`. Re-renders every frame; for typing only. |
| `useTourTime()` | The current time. Every frame; use sparingly. |

Never use wall-clock literals (`setTimeout`, a fixed delay) for anything the narration talks about. Small `offset`s after a cue are fine for sequencing a beat, such as a click landing 0.6 seconds after the pointer arrives.

### The kit

From `@daintreehq/tour/kit`: generic, timing-driven parts that know nothing about Daintree's window.

| Export | What it draws |
| --- | --- |
| `reveal(visible, from?)` | Class names for a cue-driven entrance (`"below"`, `"above"`, `"left"`, `"none"`). Opacity survives reduced motion; the lift doesn't. |
| `cn(...)` | Class-name joiner. |
| `MockCursor`, `useMockCursor(start, steps)` | A pointer that glides between `CursorStep`s (`{ cue, offset?, at, click?, modifier? }`), where `at` is an anchor (`{ anchor, dx?, dy? }`) or a canvas point. Spread the hook's result onto the component. |
| `MockTyping` | Text that types itself from a cue; `finishBy` guarantees it's done before a later cue at any narration pace. |
| `MockLines`, `MockStreamingLines` | Grey placeholder lines for text, all at once or arriving line by line. |
| `MockSpotlight` | Dims the scene and rings the named anchors. |
| `MockFocusRing`, `MockCallout`, `MockLegend`, `MockPanel`, `MockKeys`, `MockMenu`, `MockSearchField`, `MockTooltip` | Focus ring, pinned label, glyph legend, floating panel, keycaps, context menu, search field, tooltip. |
| `useTourShortcuts()` | How the host draws a shortcut (`keycaps`, `hint`), so a mocked keycap matches the real app. |
| `measureAnchor`, `TOUR_CANVAS`, `TourCanvas` | Anchor measurement, the canvas size, and the stage itself (the dialog provides it; you rarely need it). |

### The mock Daintree window

From `@daintreehq/tour/mock-app`: the whole Daintree window compressed onto the canvas, each region roughly where it really is. Build a tour on it so the viewer's map of the app carries over.

| Export | Notes |
| --- | --- |
| `MockApp` | The frame. Props: `worktrees` and `grid` (required), `focus` (the `AppRegion`s kept at full strength: `toolbar`, `sidebar`, `grid`, `dock`, `right`), `toolbarAgents`, `branch`, `dock`, `rightPanel`, `overlay` (dialogs and menus above the main area), and `children` (drawn over everything, for the spotlight and cursor). |
| `MockGrid`, `MockPane`, `MockEmptyGrid` | The panel grid, a terminal pane (`agent`, `state`, `title`, `input`, …), and an empty grid. |
| `MockWorktreeCard`, `MockWaitingPill` | A sidebar worktree card and the dock's waiting pill. |
| `MockAgentIcon`, `MockStateGlyph`, `MockCIGlyph`, `MockAppMark` | Individual glyphs. |
| `APP_LAYOUT`, `GRID_RECT`, `ANCHOR` | Layout constants for placing overlays in canvas pixels. |
| `MockKitContext`, `EMPTY_MOCK_KIT`, `resolveMockAgent`, … | The data the frame draws from. |

The mock draws only what it is handed: agents, state glyphs and CI marks arrive as data, never from the running app. A plugin tour starts with an empty kit, so an agent id renders as a name without an icon and a state id without a glyph. Export a `mockKit` (`{ agents, states, statePriority, ci, assistantIcon }`) from your scene module to draw them, using any icon component that takes a `className`. Any agent id works, built-in or your own.

The mock window's regions, layout constants and anchor names are a contract plugin scenes build on; changing them is a versioned change to `@daintreehq/tour`.

### Anchors

The cursor and the spotlight never target hand-placed coordinates. They target `data-tour-anchor` names measured from the render, so they land on the element even when the layout shifts.

- **Name your own elements** with `data-tour-anchor="<name>"`. Names are matched by value, not as a selector, so any string is safe. Prefix yours with something of your own (`acme-publish`) so they can't collide with the mock window's.
- **The mock window names its own.** Toolbar: `sidebar-toggle`, `launcher`, `toolbar-agents`, `agent-<id>`, `terminal`, `file-browser`, `project`, `forge`, `forge-issues`, `forge-prs`, `notifications`, `copy-context`, `palette`, `settings`, `assistant`, `portal`. Sidebar: `sidebar-arm`, `sidebar-plus`, `worktree-list`, `worktree-<name>`, `worktree-<name>-branch`. Dock: `dock-launcher`, `dock-waiting`. A `MockPane` names `<prefix>-titlebar`, `-glyph`, `-body`, `-input` and `-armed`, where the prefix is its `anchor` prop or its agent id.
- **An anchor that isn't rendered is skipped**, not an error: the spotlight rings the others and the cursor holds its last position. `tour preview` outlines every anchor on screen so you can see what's reachable.
- Anchors are measured again 260 ms after they appear, so a target's own entrance transition has settled before the cursor or spotlight commits to it.

## Voicing

You don't write chapter timing. The CLI voices or aligns the narration and writes the audio and timing back into your manifest entry. Both commands send your narration text (`voice`) or recordings (`align`) to Inworld, and need an Inworld API key in `INWORLD_API_KEY`; nothing is hosted for you. The audio they produce is written into your plugin and ships inside it.

### Inworld text-to-speech

```bash
daintree-plugin tour voice [--tour <id>] [--narration <file>] [--voice <id>] [--model <id>] [--only <ids>] [--force]
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--tour` | The only tour | Needed when the plugin declares more than one. |
| `--narration` | `tours/<tourId>.narration.json` |  |
| `--voice` | `Simon` | The Daintree Tour's voice; keep it unless you have a reason not to. |
| `--model` | `inworld-tts-2` |  |
| `--only` | All chapters | Comma-separated chapter ids. |
| `--force` | Off | Re-voice chapters whose narration is unchanged. |

Each chapter is voiced from its clean text (cue markers stripped, directions passed to the voice), and every cue lands on the moment its word is spoken. Chapters whose narration, voice and audio file are unchanged are skipped.

### Your own recordings

```bash
daintree-plugin tour align --recordings <dir> [--tour <id>] [--narration <file>] [--stt-model <id>] [--only <ids>]
```

Record one file per chapter, named by chapter id (`intro.wav`; `.mp3`, `.m4a`, `.ogg`, `.flac` and `.aac` also work), reading the narration as written. Small ad-libs are fine; reworded sentences shift the cues. Each recording is encoded to Ogg Opus with `ffmpeg` (which must be on your `PATH`), transcribed with word timestamps through Inworld speech-to-text (`--stt-model`, default `groq/whisper-large-v3`), and aligned back to the narration. Misheard words are interpolated between their neighbours; if fewer than 60% of a chapter's words line up, the run stops there with that chapter's timing unchanged. A chapter without a recording keeps its previous timing.

The manifest is only written once every chapter in the narration has timing, so the first run of either command has to cover them all (`--only` is for later runs). Both write it atomically, checked against the same schema Daintree loads it with, and delete only the superseded audio files they wrote themselves. Add the narration file and your raw recordings to `.dntrignore` if you don't want them in the package.

## Where audio comes from

A chapter's `audioUrl` is one of:

- **A plugin-relative path** such as `tours/welcome/intro.simon.1a2b3c4d5e6f.ogg`, resolved from the plugin root (not from `componentPath`). This is what the CLI writes, and the right choice for almost every tour: the audio ships with the plugin and plays offline.
- **An `https://` URL on a host listed in the tour's `audioHosts`**, for narration you host yourself. Daintree fetches it on the player's behalf from the URL in your manifest, and every redirect must stay on a listed host. `audioHosts` entries are bare public hostnames in ASCII (punycode): no scheme, port, wildcard, IP literal or private host.
- **`null`**, for a chapter that plays silently with its captions.

**When audio can't load, the tour still plays.** The narration is the clock while it is playing. If it is missing, refused, blocked by autoplay, or still loading after a short hold, a wall clock runs the same timeline silently: every cue fires on time, captions show, and the voice joins mid-scene if it arrives later. Mute only silences the audio; the timeline is identical. So a scene can never depend on the network, and it must never assume audio is playing.

## Previewing and testing

```bash
daintree-plugin tour preview [--tour <id>] [--narration <file>] [--only <ids>] [--theme <id>] [--port <port>]
```

Serves the tour in your browser without Daintree, loading your scene module by the same contract Daintree does, `mockKit` included. Pick a chapter, play or scrub it with its audio, see each cue as a marker on the timeline, and see every `data-tour-anchor` outlined on the canvas. It plays your built module against the React and `@daintreehq/tour` in your plugin's `node_modules`, styled with Daintree's design tokens (`--theme`, default `daintree`, picks a built-in theme; check at least one light and one dark). It warns when:

- a chapter's timing is stale against its narration (it previews the old timing until you re-voice);
- a chapter has no timing yet (it previews an estimate without audio);
- a scene waits on a cue the narration never marks, which would never fire.

For a check you can run in CI or hand to an agent:

```bash
daintree-plugin tour preview --headless --out <dir> [--settle <ms>]
```

This captures a frame at the start and at each cue of every chapter instead, after letting the scene settle (`--settle`, default 750 ms), and writes `capture.json` beside the frames with each frame's cue, time and the canvas-space rectangle of every anchor on screen, so a test can confirm the cursor and highlights land where the narration says. The command fails if a scene throws. Headless capture needs `playwright-core` and a Chromium (`npx playwright-core install chromium`).

Before shipping, run `daintree-plugin validate`, and check `daintree-plugin package --dry-run --verbose` lists your scene module and every audio file a chapter's `audioUrl` names: a `.gitignore` or `.dntrignore` pattern that catches `tours/` leaves chapters silent. Then install the plugin and open the tour from where users will find it: Help or the palette for a plugin tour, the panel's three-dots menu for a panel tour.

## In Daintree

- An enabled plugin's tours register when it loads and are withdrawn when it is disabled, uninstalled, or hidden in the project. A tour that is open at that moment closes, keeping the viewer's progress.
- A plugin reload closes an open tour too; reopening plays the new version.
- A malformed tour is reported with the offending path, like any other malformed contribution. `daintree-plugin validate` and the installer refuse it; at load, Daintree logs the issues and drops only that tour, so the rest of the plugin still loads. Exceeding the tour cap is a whole-manifest error.
- Limits: 10 tours per plugin, 32 chapters per tour, 600 seconds per chapter, 128 cues and 128 captions per chapter, 8 `audioHosts`.
