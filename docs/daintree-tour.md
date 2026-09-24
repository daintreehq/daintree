# Daintree Tour

The Daintree Tour is the optional, narrated walkthrough of the essentials: six short chapters, each a minimal animated mockup of one idea with a voice-over. It opens from **Help › Daintree Tour** (action `help.tour.show`) and from a single "Take the Daintree Tour" button on the empty panel grid during a user's first three app sessions. Closing it at any point is the skip; reopening resumes an unfinished tour where it was left.

## How it fits together

| Piece | Where | What it owns |
| --- | --- | --- |
| Narration | `src/components/Tour/tourChapters.ts` | Chapter titles, summaries, and the spoken text. `[[cue]]` markers sit immediately before the word a scene reacts to. |
| Scenes | `src/components/Tour/scenes/*.tsx` | One minimal mockup per chapter, authored on a fixed 640×360 canvas from the live theme's tokens, so it follows light and dark themes without any assets. |
| Player | `src/components/Tour/TourPlayer.ts` | The timeline. Narration audio is the clock while it plays; a wall clock runs the same timeline when audio is loading, blocked, or offline, and the voice joins mid-scene when it arrives. Mute only touches the audio. |
| Timing | `src/components/Tour/tourTiming.generated.ts` | Generated per chapter: duration, cue times, captions, and the audio URL. A chapter whose narration no longer matches its hash falls back to an estimated timeline with no audio. |
| Audio | `https://cdn.daintree.org/tour/<voice>/<chapter>-<hash>.ogg` | Ogg Opus in the `daintree-assets` R2 bucket, content-hashed and immutably cached. Never committed. All chapters preload when the tour starts playing. |
| Persistence | electron-store `onboarding.tour` | `completed`, `lastChapter`, `muted`, `launcherSessions` (counted at most once per app process). |

Scenes never use wall-clock literals for anything the narration talks about: they read `useCue("id")`, so re-voicing re-times every animation. `src/components/Tour/__tests__/tourContent.test.ts` fails if a scene reads a cue the narration doesn't define, or the narration defines one no scene uses.

## Regenerating the narration

Edit the words in `tourChapters.ts`, then:

```bash
npm run tour:audio                 # voices only the chapters whose text changed (Inworld, voice "Simon")
npm run tour:audio -- --force      # re-voice everything
npm run tour:audio -- --no-upload  # dry run: timings only, nothing published
```

It needs `INWORLD_API_KEY` and `CLOUDFLARE_API_TOKEN` (uploads go through `wrangler r2 object put`). Commit the regenerated `tourTiming.generated.ts`; the old audio objects can stay on the CDN since shipped builds still point at them.

## Replacing the voice with real recordings

1. Record one file per chapter, named by chapter id: `welcome`, `worktrees`, `agents`, `state`, `fleet`, `review` (`.wav`, `.m4a`, `.mp3`, `.flac` or `.ogg`). Read the narration as written in `tourChapters.ts` — small ad-libs are fine, but reworded sentences shift the cues.
2. Put them in one folder and run `npm run tour:audio -- --recordings <folder>`.

The script transcribes each recording with OpenAI (`OPENAI_API_KEY`) to get word timestamps, lands every cue on the word as actually spoken, encodes to Ogg Opus with `ffmpeg`, uploads, and rewrites the manifest. A chapter without a recording keeps its previous audio. Preview the result with the harness below before committing.

## Previewing

`tour-preview.html` renders the dialog outside Electron with a stubbed onboarding bridge: `?theme=<id>`, `?chapter=<id>`, `?t=<seconds>` to freeze a moment, `?muted=1`. `window.__tour` is the live player.
