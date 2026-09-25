# Daintree Tour

The Daintree Tour is the optional, narrated walkthrough of the essentials: six short chapters, each a minimal animated mockup of one idea with a voice-over. It opens from **Help › Daintree Tour** (action `help.tour.show`) and from a single "Take the Daintree Tour" button on the empty panel grid during a user's first three app sessions. Closing it at any point is the skip; reopening resumes an unfinished tour where it was left.

## How it fits together

| Piece | Where | What it owns |
| --- | --- | --- |
| Narration | `src/components/Tour/tourChapters.ts` | Chapter titles, summaries, and the spoken text. `[[cue]]` markers sit immediately before the word a scene reacts to. |
| Scenes | `src/components/Tour/scenes/*.tsx` | One minimal mockup per chapter, authored on a fixed 640×360 canvas from the live theme's tokens, so it follows light and dark themes without any assets. |
| Player | `src/components/Tour/TourPlayer.ts` | The timeline. Narration audio is the clock while it plays; a wall clock runs the same timeline when audio is loading, blocked, or offline, and the voice joins mid-scene when it arrives. Mute only touches the audio. |
| Keyboards | `src/components/Tour/tourKeys.ts` | Shortcuts in the narration are `{{action.id}}` tokens (an action's default binding) or `{{Alt+Enter}}` (a key the app hard-codes). A chapter with a token is voiced twice: `mac` ("Command Option O") and `pc` ("Control Alt O", shared by Windows and Linux, whose defaults match). Scenes draw keycaps and hints from the same tokens through the app's `parseChord`, so what is shown is what is said. |
| Timing | `src/components/Tour/tourTiming.generated.ts` | Generated per recording: duration, cue times, captions, and the audio URL, keyed by chapter id, or `<id>.mac` / `<id>.pc` for a chapter that names a shortcut. A recording whose narration no longer matches its hash falls back to an estimated timeline with no audio, still in the viewer's keyboard. |
| Audio | `https://cdn.daintree.org/tour/<voice>/<key>-<hash>.ogg` | Ogg Opus in the `daintree-assets` R2 bucket, content-hashed and immutably cached. Never committed. All chapters preload when the tour starts playing. |
| Persistence | electron-store `onboarding.tour` | `completed`, `lastChapter`, `muted`, `launcherSessions` (counted at most once per app process). |

Scenes never use wall-clock literals for anything the narration talks about: they read `useCue("id")`, so re-voicing re-times every animation. `src/components/Tour/__tests__/tourContent.test.ts` fails if a scene reads a cue the narration doesn't define, or the narration defines one no scene uses.

## Regenerating the narration

Edit the words in `tourChapters.ts`, then:

```bash
npm run tour:audio                 # voices only the chapters whose text changed (Inworld voice "Simon")
npm run tour:audio -- --force      # re-voice everything
npm run tour:audio -- --only pilot    # one chapter (both keyboards), or a key like pilot.pc
npm run tour:audio -- --no-upload  # dry run: timings only, nothing published
```

It needs `INWORLD_API_KEY` and `CLOUDFLARE_API_TOKEN` (uploads go through `wrangler r2 object put`). Commit the regenerated `tourTiming.generated.ts`. The script checks every audio URL in the manifest resolves on the CDN before writing it.

**Never delete or overwrite anything under `tour/` in the bucket.** Each release compiles in its own manifest and plays exactly the URLs it names, so every object ever referenced by a shipped build has to stay. Keys are content-hashed (`<key>-<sha256 prefix>.ogg`, cached immutable), so a re-voice, a new voice folder, or a new keyboard variant only ever adds objects; old builds keep playing theirs, and a build whose audio still went missing falls back to its silent timeline with captions.

## Replacing the voice with real recordings

1. Record one file per chapter, named by chapter id (`welcome`, `worktrees`, …; `.wav`, `.m4a`, `.mp3`, `.flac` or `.ogg`). A chapter that names a shortcut needs two, `pilot.mac` and `pilot.pc`, each reading that keyboard's key names. Read the narration as written in `tourChapters.ts` — small ad-libs are fine, but reworded sentences shift the cues.
2. Put them in one folder and run `npm run tour:audio -- --recordings <folder>`.

The script encodes each recording to Ogg Opus with `ffmpeg`, transcribes it with Inworld speech-to-text (`inworld/inworld-stt-1` by default; `--stt-model` picks another model Inworld routes, e.g. `groq/whisper-large-v3`) to get word timestamps, lands every cue on the word as actually spoken, uploads, and rewrites the manifest. Words the recogniser mishears are interpolated between their neighbours; if fewer than 60% of words line up, that chapter fails and nothing is published for it. A chapter without a recording keeps its previous audio. Preview the result with the harness below before committing.

## Previewing

`tour-preview.html` renders the dialog outside Electron with a stubbed onboarding bridge: `?theme=<id>`, `?chapter=<id>`, `?t=<seconds>` to freeze a moment, `?muted=1`, `?keyboard=mac|pc` to narrate and draw one keyboard. `window.__tour` is the live player.

`DAINTREE_SHOT_TOUR=1 npx playwright test --project=screenshots tour-dialog-review` captures the dialog's states (paused, playing, long caption, end card, held, finish, track hover, stage focus, transition, short window) across themes into `artifacts/tour-dialog-shots/` (`DAINTREE_SHOT_DIR` overrides), and asserts the focus handoffs in a real browser.
