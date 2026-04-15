---
name: demo-video-creator
description: Guide for writing and recording Daintree demo videos. Use when creating demo scenarios, working with the Stage DSL, or recording screen captures.
---

# Demo Video Creator

Create polished demo videos of Daintree by writing scenario scripts and recording them with the built-in capture pipeline.

## Workflow

1. **Find selectors** — Browse `e2e/helpers/selectors.ts` for the `SEL` registry. Every UI element you interact with needs a selector from this registry.
2. **Create a scene file** — Add `demo/scenes/<name>.ts`. Export a default `ScenarioConfig` object.
3. **Write scenes** — Each scene is an async function receiving a `Stage` instance. Compose primitives to script the interaction.
4. **Configure output** — Set `outputFile`, `preset`, and `fps` in your `ScenarioConfig`.
5. **Test interactively** — Run `npm run demo` to launch Electron in demo mode for manual visual inspection of the app state before recording.
6. **Record** — Run `npm run demo:record -- --scenario <name>` to capture a video. Override defaults with `--output <path>`, `--preset <preset>`, `--fps <n>`.

## Key Files

| Purpose                    | Path                                |
| -------------------------- | ----------------------------------- |
| Stage DSL (all primitives) | `demo/stage.ts`                     |
| CLI runner                 | `demo/runner.ts`                    |
| Scene definitions          | `demo/scenes/`                      |
| Selector registry          | `e2e/helpers/selectors.ts`          |
| IPC type contracts         | `shared/types/ipc/demo.ts`          |
| Preload wiring             | `electron/preload.cts` (demo block) |
| IPC handlers               | `electron/ipc/handlers/demo.ts`     |

## Scenario Config

```typescript
import type { ScenarioConfig, Scene } from "../stage.js";

const myScene: Scene = async (stage) => {
  // ... use stage primitives
};

export default {
  outputFile: "demo-output/my-video.mp4",
  preset: "youtube-1080p",
  fps: 30,
  scenes: [myScene],
} satisfies ScenarioConfig;
```

## Stage DSL Reference

### Cursor

```typescript
stage.cursor.moveTo(selector, { durationMs?, offsetX?, offsetY? })
stage.cursor.click(selector?)  // moveTo + click; omit selector for click-in-place
```

### Keyboard

```typescript
stage.keyboard.type(selector, text, { cps? })  // type into a focused element
stage.pressKey(key, code?, modifiers?, selector?)  // press a single key
// modifiers: "mod" | "ctrl" | "shift" | "alt" | "meta"
```

### Camera

```typescript
stage.camera.zoom(factor, { durationMs? })
```

### Scroll & Drag

```typescript
stage.scroll(selector)  // scroll element into view
stage.drag(fromSelector, toSelector, durationMs?)
```

### Spotlight & Annotate

```typescript
stage.spotlight(selector, padding?)      // highlight an element
stage.dismissSpotlight()

const { id } = await stage.annotate(selector, text, position?, id?)
// position: "top" | "bottom" | "left" | "right"
stage.dismissAnnotation(id?)  // dismiss specific or all annotations
```

### Wait & Timing

```typescript
stage.wait.forSelector(selector, { timeoutMs? })
stage.waitForIdle(settleMs?, timeoutMs?)  // wait for UI to settle
stage.sleep(ms)
```

### Capture

The capture pipeline encodes directly to the output file via ffmpeg — there is no intermediate frame directory.

```typescript
const capture = await stage.startCapture({ fps, outputPath, preset });
// ... run scenes ...
const result = await stage.stopCapture();
// result.outputPath — path to the final video
// result.frameCount — number of frames captured
```

The runner handles capture automatically. You only need these methods if building a custom recording flow.

## Encode Presets

| Preset          | Format                | Use case                      |
| --------------- | --------------------- | ----------------------------- |
| `youtube-4k`    | MP4, H.264, 3840x2160 | YouTube uploads, high quality |
| `youtube-1080p` | MP4, H.264, 1920x1080 | YouTube uploads, standard     |
| `web-webm`      | WebM, VP9             | Web embedding, smaller files  |

## Tips

- Keep scenes short and focused — one interaction sequence per scene
- Use `stage.sleep()` between actions for natural pacing (500-1500ms typical)
- Use `stage.wait.forSelector()` before interacting with elements that load asynchronously
- Use `stage.spotlight()` to draw attention to a specific element before interacting with it
- Use `stage.annotate()` to add text labels explaining what's happening
- Selectors from `SEL` are data-testid based — add new ones in `e2e/helpers/selectors.ts` if needed

$ARGUMENTS
