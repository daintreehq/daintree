---
name: daintree-tour
description: Author, voice, and verify a narrated welcome tour for a Daintree plugin or one of its panels — the contributes.tours manifest entry, narration with cue markers, stylized scenes built with @daintreehq/tour/kit, audio and timing through `daintree-plugin tour voice`/`tour align`, and a self-check with `tour preview --headless`. Use when the author wants to add a tour, change or re-voice an existing tour's narration, fix a tour's scenes, or check that a tour lines up.
---

# Daintree plugin tours

A tour is a few short narrated chapters that play in Daintree's tour dialog. Each chapter is one idea: a sentence or three of narration, and a stylized mock scene on a fixed 640×360 canvas that reacts to cues in that narration. You take the author from nothing to a tour that is voiced, timed, captured, compared against Daintree's own tour, and validated.

Run every command from the plugin directory (where `plugin.json` is). Read the reference file for a step before doing it:

- `references/manifest-and-build.md` — the `contributes.tours` entry, the scene module's export, dependencies and the Vite entry
- `references/narration-and-audio.md` — writing for the ear, cue and direction syntax, voices, the Inworld key, recordings, regenerating
- `references/scenes.md` — the kit, the visual style every scene follows, a complete example scene
- `references/verification.md` — headless capture, reading `capture.json`, the per-cue and style review, validation

## Rules that are never bent

- **The Inworld key is never written anywhere that could be committed** — not the plugin, its manifest, `package.json`, a script, `.env`, a settings file, this skill, or your own notes. Never ask the author to paste it into the chat, and never print it. It reaches the CLI only through the `INWORLD_API_KEY` environment variable of the one command that needs it (see `references/narration-and-audio.md`).
- **Every scene is a stylized mock built with the kit**, never a screenshot, screen recording, or image of the real UI — however small the tour, even a single chapter.
- **Never hand-write a chapter's `duration`, `cues`, `captions`, `audioUrl` or `narrationHash`.** Only `tour voice` and `tour align` write them, from the audio.
- **Scenes never time anything the narration talks about with wall-clock literals.** They read cues (`useCue`), so re-voicing re-times every animation.
- **Report what you actually verified.** If there was no key, no Chromium, or no test script, say so; do not describe the tour as checked.

## Workflow

### 1. Establish the target

Read `plugin.json`, `package.json`, `vite.config.ts` and any existing `tours/` folder.

- `"scope": "project"` in `plugin.json` means a project plugin, and Daintree refuses tours from project plugins. Stop and tell the author; a tour needs an installed (packaged) plugin.
- An existing `contributes.tours` entry means you are revising, not creating: skip to the step the author's change needs (usually 3 or 6).
- A plugin may declare at most 10 tours, a tour at most 32 chapters.

### 2. Interview the author

Ask these together, in one message, with your recommendation for each:

1. **Plugin tour or panel tour?** A plugin tour is offered from Help and the command palette. A panel tour opens from one panel's menu and must name one of this plugin's own `contributes.panels` ids — list them and ask which.
2. **What should it show, and roughly how many chapters?** Suggest a split: one idea per chapter, usually 2–5 chapters of 15–30 seconds each. Daintree's own tour runs 20–35 seconds a chapter.
3. **Which voice?** Recommend `Simon`, the voice Daintree's own tour uses. Offer alternatives the author can audition in the Inworld TTS playground (for example `Ashley` or `Dennis`), or any Inworld voice id they already use. Do not describe voices you have not heard.
4. **Audio source.** `INWORLD_API_KEY` already set in the environment; a key file the author points you at (a path — never its contents); or their own recordings (these are still timed with Inworld speech-to-text, so a key is needed either way, plus `ffmpeg`).

Check the environment variable with `test -n "$INWORLD_API_KEY" && echo set || echo unset` — never `echo $INWORLD_API_KEY`.

### 3. Write the narration

Create `tours/<tourId>.narration.json` following `references/narration-and-audio.md`. Show the author the narration before voicing it; voicing costs money and every word change re-times the chapter.

### 4. Declare the tour and build the scenes

Add the manifest entry with `"chapters": []`, the dependencies, the Vite entry and the scene module per `references/manifest-and-build.md`. Write one scene per chapter per `references/scenes.md`: every cue the narration marks is used by the scene, and every cue the scene reads is marked in the narration. Then `npm run build`.

### 5. Voice and time

`npx daintree-plugin tour voice --voice <voice>` (or `tour align --recordings <dir>`), with the key supplied as in `references/narration-and-audio.md`. The command writes the audio into `tours/<tourId>/` and the timing into `plugin.json`. Without a key, stop here and tell the author the exact command to run themselves; the preview still works on estimated timing.

### 6. Verify

Follow `references/verification.md`: `tour preview --headless`, read `capture.json`, look at every frame against the narration and against Daintree's own scenes, fix and recapture until it holds, then `npx daintree-plugin validate` and the plugin's own test or typecheck scripts if it has any.

### 7. Hand over

Tell the author what was built, which chapters were voiced with which voice, what the review found and fixed, anything left unverified, and how to regenerate:

- Words, directions or cue markers changed → `tour voice --voice <voice>` again (only changed chapters are re-voiced), rebuild if scenes changed, recapture.
- Only a scene changed → `npm run build` and recapture; no re-voice.
- New voice → `tour voice --voice <new>`; every chapter not already in that voice is re-voiced.

Always pass the tour's `--voice` explicitly: the flag defaults to `Simon`, so a bare `tour voice` on a tour voiced with anything else re-voices every chapter in Simon.
