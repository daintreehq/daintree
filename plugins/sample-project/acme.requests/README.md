# Request Desk

A project application for Daintree: a small list of requests that agents in this project read and change through the app's own tools, a report built in the background, and a short welcome tour. Everything is synthetic — the report provider runs offline and the three demo requests are made up — so it is safe to open, change and delete.

It lives in this repository at `.daintree/plugins/acme.requests/` and loads only while this project is open in Daintree. `daintree-plugin new --project` copies it, built, under the name you choose.

## The committed `dist/` is the load contract

Daintree reads `plugin.json` and the files under `dist/`. It never compiles this plugin, never reads `src/`, and never runs `package.json`. So `dist/` is committed and `.gitignore` force-includes it: anyone who opens the project, including an agent in a fresh worktree, gets the app without installing or building anything. Rebuild and commit `dist/` in the same commit as the source change that caused it.

## What it shows

| Part | Where |
| --- | --- |
| The application: a Home beside the grid, a sidebar view, a settings section, a welcome tour and a first workflow | `application` in `plugin.json` |
| Shared navigation between the sidebar and Home, restored after a restart | `application.navigation`, `src/views/sidebar.tsx`, `src/views/home.tsx` |
| A settings section with a Connection page, reachable from settings search and the setup checklist | `src/views/settings.tsx`, `contributes.settings`, `contributes.setup` |
| A SQLite store with append-only migrations and demo records seeded exactly once | `src/store.ts`, `contributes.databases` |
| Agent tools served to agents launched in this project | `src/index.ts`, `contributes.agentMcp` |
| Choose an agent → prompt → a tool changes the data → the views update | the `first-request` command, `db.onDidChange`, `useCachedHostChannel({ invalidateOn })` |
| A durable report operation over a synthetic provider | `src/provider.ts`, `@daintreehq/plugin-sdk/operations` |
| The report as an artifact, previewed with the kit, never fetched into the view | `reports.artifact` in `src/index.ts`, `MediaThumbnail` in `src/views/home.tsx` |
| A skill agents load, and a recipe that starts an agent on the requests | `skills/request-desk.md`, `contributes.recipes` |
| A narrated tour | `tours/welcome.narration.json`, `src/tour.tsx` |

## Recovery

- **Drafts.** An unsaved edit is written to the view's durable state (`persistState`) and reported with `setHasUnsavedChanges`, so a remount, a Home/Grid switch or a restart restores it, and the host refuses to navigate away from it (`unsaved`) until it is saved or discarded. An edit someone else's write overtook is offered as keep-or-replace; one whose request was deleted is explained. See `src/views/draft.ts`.
- **Jobs.** A report is journaled before the provider hears of it. If the worker stops mid-build, the next activation reconciles with the provider by idempotency key and carries on; a report the manager stopped tracking can be resumed from Home or the task's Retry. The report file is durable; its artifact lasts the session and is re-imported when gone.
- **Navigation.** Only `requestId` is persisted. A saved location that no longer resolves — the request deleted, or `navigation.version` raised — lands on the default section, and Home explains a request that has gone.

## Authoring loop

```bash
cd .daintree/plugins/acme.requests
npm install
npm run dev          # rebuilds dist/ on save
npm test             # the worker against a mock host and a real SQLite file
npm run typecheck
npx playwright install chromium   # once
npm run test:preview # every story in review/, screenshots in test-results/
npx daintree-plugin validate
npx daintree-plugin doctor
```

Preview a view with `npm run test:preview`, not by driving Daintree's own window. Load the plugin in Daintree only for what the host alone shows: activation, the worker, real data and its performance numbers.

## The tour

`tours/welcome.narration.json` is the script. The manifest's chapter timing is an estimate from it and the chapters play silently with captions. To voice it with Daintree's tour voice, set `INWORLD_API_KEY` and run `npx daintree-plugin tour voice`; it writes the audio under `tours/welcome/` and the real timing into `plugin.json`. `npx daintree-plugin tour preview` plays it without Daintree.

## Making it yours

Rename the records, the tools and the views; keep the shape. Replace `syntheticReportKind` in `src/provider.ts` with your provider's client — `submit`, `poll`, `reconcile` and `cancel` are what the operation manager needs — and store its credential in a `type: "secret"` setting the worker reads, never in the database or the view.
