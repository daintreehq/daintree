# Manifest entry and build

## The `contributes.tours` entry

Start the entry with no chapters. `tour voice` / `tour align` fill `chapters` in narration order; until then `daintree-plugin validate` reports the tour as incomplete, which is expected.

```json
{
  "contributes": {
    "tours": [
      {
        "id": "welcome",
        "title": "Welcome to Acme",
        "componentPath": "dist/tour.js",
        "chapters": []
      }
    ]
  }
}
```

| Field | Notes |
| --- | --- |
| `id` | Lowercase letters, digits, hyphens. Names the narration file (`tours/<id>.narration.json`) and the audio folder (`tours/<id>/`). |
| `title` | Shown where the tour is offered, up to 120 characters. |
| `componentPath` | The built scene module, relative to the plugin root. |
| `panelKind` | Only for a panel tour: the `id` of one of this plugin's own `contributes.panels`. Omit for a plugin tour. |
| `audioHosts` | Only if audio is hosted remotely. The CLI writes local audio (`tours/<id>/…ogg`), which ships inside the plugin, so leave this out. |
| `chapters` | Written by the CLI. Never add `duration`, `cues`, `captions`, `audioUrl` or `narrationHash` yourself. |

Errors `daintree-plugin validate` may report and what they mean:

- `tour_panel_kind_unknown` — `panelKind` isn't one of this plugin's panel ids.
- `tour_cue_out_of_range` / `tour_caption_out_of_range` — timing and audio disagree; re-run `tour voice` rather than editing numbers.
- `tour_chapter_duplicate_id`, `duplicate_contribution_id` — two chapters or two tours share an id.
- A missing `chapters` / `narrationHash` / `duration` — the tour has not been voiced yet.
- A project-scope error naming `tours` — project plugins can't contribute tours.

## The scene module

The module at `componentPath` must default-export exactly this shape — it is what Daintree loads, and `tour preview` holds the module to the same contract:

```tsx
import { IntroScene } from "./tour/IntroScene";
import { PublishScene } from "./tour/PublishScene";

export default {
  scenes: { intro: IntroScene, publish: PublishScene },
  chapterTitles: { intro: "Meet the site builder", publish: "Go live" },
};
```

- `scenes` has one zero-prop component per chapter id, and nothing else is keyed by chapter.
- `chapterTitles` is optional; a chapter without one is titled by its id. Give every chapter a short title (under about 40 characters), written like the built-in tour's: "One task, one worktree", "See who needs you".
- `mockKit` is optional. Everything in `@daintreehq/tour/mock-app` that draws an agent, an agent state, a CI mark or the assistant button (`MockPane`, `MockApp`'s toolbar agents, `MockWorktreeCard` states) reads its visuals from it, and draws nothing for them without one. Plugin tours rarely use those; if one does, supply a kit (see the `MockKit` type in `mock-app.d.ts`) or draw the plugin's own UI with the kit parts instead.
- A flat map (`export default { intro: IntroScene }`) is wrong: Daintree refuses it.

Put scene files under `src/tour/` and the module at `src/tour.tsx`.

## Dependencies

The scene module is built with the plugin's Vite config. `@daintreehq/plugin-vite` leaves `react` and every `@daintreehq/tour` import bare, so at runtime they come from Daintree itself; the plugin's own copies are for types, the build, and `tour preview`.

```bash
npm install --save-dev @daintreehq/tour react react-dom @types/react @types/react-dom lucide-react
npm install --save-dev playwright-core   # for tour preview --headless
npx playwright-core install chromium
```

Only add what's missing — a `view` or `full` scaffold already has React. `lucide-react` is needed because the kit draws its icons with it; scenes may use it for their own icons too.

`tsconfig.json` needs `"jsx": "react-jsx"` and `src/**/*.tsx` in `include` if the plugin didn't have JSX yet.

## The Vite entry

Add the tour module to `build.lib.entry` in `vite.config.ts`, alongside what's there:

```ts
entry: {
  index: "src/index.ts",
  tour: "src/tour.tsx",
},
```

It builds to `dist/tour.js`, which is the `componentPath`. Don't touch a separate server config (`vite.config.server.ts`) if the plugin has one.

## Files that are committed

`plugin.json`, `tours/<id>.narration.json`, `tours/<id>/*.ogg` (the CLI removes superseded takes itself), and the scene sources. Capture output (`.tour-preview/`) is not; add it to `.gitignore` if it isn't there. If the author doesn't want the narration file or raw recordings in the packaged `.dntr`, add them to `.dntrignore` — never the `.ogg` files the manifest points at.
