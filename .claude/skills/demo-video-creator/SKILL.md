---
name: demo-video-creator
description: Stage Daintree for a screencast — build a throwaway demo project with worktrees, a remote and dirty state, bake an app profile so it opens straight into that state, and generate a shot card the recordist follows. Use whenever the user wants to make a demo video, screencast, product clip or feature walkthrough of Daintree. The harness does the setup; a human drives the mouse and records with their own screen recorder.
---

# Demo Video Creator

This skill stages Daintree for recording. It does **not** record anything and does not animate a cursor — the person recording drives the mouse themselves and captures with their own tool (Screen Studio, QuickTime, OBS). The harness exists so they never have to build a demo project, wire a remote, dirty a worktree, or click through onboarding before every take.

The in-app demo engine (`window.electron.demo`, animated cursor, MediaRecorder capture) is being retired in favour of this. It shipped inside the renderer behind a flag to do a job that turned out to be a filesystem problem. Ignore it — do not drive `window.electron.demo` for new work.

## The shape of a demo

**Permanent** (committed, maintained): the machinery — `e2e/helpers/demoScene.ts`, `demoProfile.ts`, `demoTake.ts`, `demoShotCard.ts`, and the `npm run demo` dispatcher in `scripts/demo/`.

**Temporary** (never committed, deleted afterwards): one scene file per video, plus everything under `<demo root>/<slug>*`. Scenes are plain JSON on purpose — the machinery is the code, a specific video is data. Put scene files in `.demo/` (gitignored) or a scratch directory.

## Workflow

```bash
npm run build:e2e                      # required: takes launch the built app
npm run demo stage .demo/intro.json    # build scene, bake profile, write shot card
npm run demo take .demo/intro.json     # rebuild the repo, reset the profile, launch
# ... record ...                       # quit with Cmd+Q when the take is done
npm run demo take .demo/intro.json     # next take, identical starting state
npm run demo clean .demo/intro.json    # delete the scene, snapshot and profiles
```

`npm run demo list` shows every command. The shot card is written next to the snapshot and its path is printed by `stage` and `take`.

## Authoring a scene

Everything the app opens into comes from this file. Write it, then read the generated shot card back — the card's "Before you roll" section is rendered from the built scene, so if it does not describe what you intended, the scene is wrong, not the card.

Beats describe what the *recordist* does; they stage nothing. Only write a beat about state the scene actually creates — a beat claiming three working agents against a scene with one worktree and no agents is a card that lies from its first line.

```json
{
  "slug": "intro",
  "remote": true,
  "files": { "README.md": "# surge-checkout\n", "src/checkout.ts": "export const rate = 0.02;\n" },
  "worktrees": [
    {
      "branch": "feature/refund-retries",
      "files": { "src/refund.ts": "// baseline\n" },
      "push": true,
      "aheadCommits": [{ "message": "wip", "files": { "src/retry.ts": "// retry\n" } }],
      "uncommittedFiles": { "src/refund.ts": "// edited, ready to review\n" }
    }
  ],
  "beats": [
    {
      "name": "Isolation",
      "given": "One worktree, ahead of origin, with an edit waiting for review",
      "action": "Hold on the worktree list, then open Review & Commit",
      "waitFor": "The diff to render",
      "expect": "src/refund.ts shows as modified",
      "super": "Every task gets its own git worktree.",
      "seconds": 12
    }
  ]
}
```

Scene fields worth knowing:

- **`remote: true`** creates a local bare repo wired as `origin`. Push, fetch and ahead/behind counts work with no network and no credentials. PR and CI chips do **not** — those come from a forge plugin, and the scene schema has no way to point at a real GitHub repo. A beat that needs a green PR check cannot be staged by this harness at all; record it against a real project by hand.
- **`uncommittedFiles`** is what Review Hub shows. A scene whose worktrees are all clean gives the review beat nothing to display.
- **`aheadCommits`** requires `push: true`. Daintree suppresses the ahead count entirely when a branch has no upstream, so ahead-commits without a push produce history the UI never surfaces.
- **`beats`** are the shot card only — they never affect what gets built. Time all of them or none: an untimed beat counts as zero, so a half-timed list makes every later beat claim an earlier start than it has.

## Staging UI state

`stage` opens the project and completes onboarding, but panels, layout and active worktree come from a `setup` callback. Today that means editing the `stage` command in `scripts/demo/index.ts` to pass `setup` to `bakeProfile`; it receives the live Playwright `page`, so anything an E2E spec can do, a bake can do.

Whatever you stage, verify it survives: the smoke test (`e2e/demo/staging-smoke.spec.ts`) is the template for asserting that a staged panel is still there after restore.

## Gotchas, all learned the hard way

- **Takes reset the repo; the snapshot does not.** `take` rebuilds the scene by default precisely because a recording mutates it — an agent writes files, you commit, something gets pushed. Pass `--keep-repo` only when a beat deliberately continues from the previous *repository* state — it still resets the app profile, so panels and layout return to the baked arrangement either way.
- **Quit with Cmd+Q, not the window close button.** On macOS closing the window does not quit Daintree, and the next take will refuse because the profile is still held.
- **A killed take leaves a stale marker.** If the app is force-killed it can rebuild its profile during shutdown and leave `running.lock` behind. Every later take then refuses even though nothing is running. `npm run demo take <scene> -- --force` discards that profile; only use it when you are sure no app is up.
- **No e2e flags reach a take.** A take runs with a sanitised environment and no `--daintree-e2e-*` switches, so it behaves like the build a viewer downloads. That is why onboarding has to be genuinely persisted during the bake rather than suppressed by a flag — the flag makes onboarding *report* itself complete without writing anything.
- **Editing a scene does not re-bake it.** `take` rebuilds the repository from the current JSON but reuses the profile baked earlier. Change anything that affects the staged UI and you must run `stage` again; nothing currently detects the mismatch for you.
- **`npm run build:e2e` first.** A take launches the repo root, which Electron resolves through `dist-electron/`. Without a build you are recording a stale app or no app.

## When you are done

`npm run demo clean <scene>` removes the scene, its worktrees, the bare origin, the snapshot and the take profile. Then delete the scene file. Nothing about one video should outlive it — that is the whole reason the scene is data and not code.
