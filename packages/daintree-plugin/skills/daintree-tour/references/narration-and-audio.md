# Narration, voice and audio

## The narration file

`tours/<tourId>.narration.json`, chapters in playing order:

```json
{
  "chapters": [
    {
      "id": "intro",
      "narration": "This is the Acme site builder. [[pages]] Every page you add shows up in this list, and [[preview]] the preview on the right updates as you type."
    },
    {
      "id": "publish",
      "narration": "When you're happy with it, [[publish]] press Publish, and [[live]] your site is live in a few seconds."
    }
  ]
}
```

Chapter ids are lowercase letters, digits and hyphens, and must match the scene module's `scenes` keys. The file order is the tour's order; the CLI rewrites `plugin.json`'s chapters to match it.

## Cue markers and directions

- `[[cue-id]]` sits immediately before the word the scene reacts to. The cue fires the moment that word is spoken. Ids are lowercase letters, digits and hyphens, unique within the chapter, and every cue needs a word after it.
- `[single brackets]` are delivery directions for the voice — how a line is said, never what. They are sent to the voice but left out of captions. Write them as short stage directions that combine two qualities (`[warm and unhurried]`), at the start of a sentence, and sparingly: each one holds until the next and every switch is audible. Most tours need none.
- Cues are stripped from captions and from what is spoken.

## Writing for the ear

The narration is heard once, at speaking pace, while the viewer is watching a scene. Model it on Daintree's own tour:

> Everything starts with a [[project]] project: any folder you open. When it's a git repository, [[list]] its worktrees sit down the left. Each one is a separate working folder on [[branch]] its own branch, so use one per task, and agents on different tasks don't step on each other's files.

- One idea per chapter. Two to five sentences, roughly 40–90 words, 15–35 seconds spoken. Hard limit: 2,000 characters per chapter.
- Short sentences, plain words, second person. Say what the viewer does and what they get.
- No symbols, abbreviations, file paths, URLs, or anything a voice has to guess how to say. Spell out keys the way people say them ("Command K", "press Enter").
- Name what's on screen as it appears: the cue goes on the word that names the thing, so the scene can show it at that moment.
- A cue every one to two sentences keeps the scene alive. Space cues at least about a second apart — two cues on adjacent words give the scene no time to show the first.
- Don't narrate the tour itself ("in this chapter…"), and don't end chapters on filler.

Before voicing, check each chapter: every cue id is unique, every cue has a word after it, no direction is left dangling at the end, and every cue has a matching `useCue` in its scene (and vice versa).

## The Inworld key

The CLI reads the key only from `INWORLD_API_KEY` in its own environment. There is no flag and no config file for it, on purpose.

- **Already in the environment** — run the command as is.
- **In a file the author names** — load it into that one command's environment, reading the file in the same line. The file must contain only the key and must live outside the plugin (or be gitignored). Never copy it, never `cat` it on its own, never `source` it.

  macOS / Linux:

  ```bash
  INWORLD_API_KEY="$(tr -d '\r\n' < /absolute/path/to/inworld.key)" npx daintree-plugin tour voice --voice Simon
  ```

  Windows PowerShell:

  ```powershell
  $env:INWORLD_API_KEY = (Get-Content -Raw 'C:\path\to\inworld.key').Trim(); npx daintree-plugin tour voice --voice Simon; Remove-Item Env:INWORLD_API_KEY
  ```

- **No key** — stop before voicing and give the author the command to run themselves. The preview still plays on estimated timing, so scenes can be built and reviewed first.

Never write the key, or a command containing it literally, into any file: not the plugin, not `package.json` scripts, not `.env`, not this skill. If you see a key in a file inside the plugin, tell the author and suggest they rotate it.

## Voicing

```bash
npx daintree-plugin tour voice --voice Simon
npx daintree-plugin tour voice --voice Simon --only intro,publish   # just these chapters
npx daintree-plugin tour voice --voice Simon --force                # re-voice everything
```

Other flags: `--tour <id>` when the plugin has several tours, `--narration <file>` for a narration file elsewhere, `--model <id>` for an Inworld TTS model other than `inworld-tts-2`.

- The first run must voice every chapter that has no timing yet; `--only` can't leave one out.
- A chapter whose narration and voice are unchanged, and whose audio is still on disk, is skipped. Editing a chapter's words, directions or cue markers makes its timing stale until it is re-voiced.
- `--voice` defaults to `Simon`. Always pass the tour's voice explicitly, or a tour voiced in another voice is re-voiced in Simon.
- Audio lands in `tours/<tourId>/<chapter>.<voice>.<hash>.ogg`; superseded takes are deleted once `plugin.json` no longer points at them. Commit the new files.

## The author's own recordings

One file per chapter, named by chapter id: `intro.wav`, `publish.m4a` (`.wav`, `.mp3`, `.m4a`, `.ogg`, `.flac` or `.aac`), all in one folder — keep that folder outside the plugin or in `.dntrignore`. The reader reads the narration as written; small ad-libs are fine, reworded sentences move the cues.

With the key supplied the same way as for voicing:

```bash
npx daintree-plugin tour align --recordings /absolute/path/to/recordings
npx daintree-plugin tour align --recordings /absolute/path/to/recordings --only intro
```

It needs `ffmpeg` on the PATH and an Inworld key (speech-to-text, `--stt-model`, default `groq/whisper-large-v3`). Each recording is encoded to Ogg Opus in the plugin, transcribed with word timestamps, and each cue lands on the word as actually spoken. If too few words line up, that chapter fails — re-record it closer to the script, or change the script to match what was said and align again.

## Regenerating after an edit

| What changed | Do |
| --- | --- |
| A chapter's words, directions or cues | Update its scene if cues changed, `npm run build`, `tour voice --voice <voice>` (or `tour align` with a new recording), recapture that chapter |
| Only a scene | `npm run build`, recapture |
| Chapter added, removed or reordered | Edit the narration file and scene module together, build, `tour voice --voice <voice>`; the CLI drops chapters the narration no longer lists |
| The voice | `tour voice --voice <new>` |

`tour preview` warns when a chapter's timing is stale against its narration — that is the signal something was edited and not re-voiced.
