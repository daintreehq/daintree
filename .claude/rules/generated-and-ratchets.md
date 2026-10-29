---
paths:
  - "scripts/baselines/**"
  - "scripts/**/*ratchet*"
  - "scripts/**/*budget*"
  - "eslint.config.*"
  - "shared/types/ipc/generated*.ts"
  - "docs/keyboard-shortcuts.md"
  - "electron/services/persistence/migrations/**"
  - "assistant/**"
  - "scripts/assistant-src/**"
  - "scripts/build-assistant-prompts.mjs"
  - "scripts/codegen/**"
  - "shared/config/defaultKeybindings.ts"
  - "src/services/defaultKeybindings.ts"
  - "electron/services/persistence/schema.ts"
  - "scripts/ci/check-e2e-waits.mjs"
  - "scripts/check-test-ratio.mjs"
  - "scripts/theme-text-ramp.ts"
---

# Generated code and ratchets

**Never hand-edit generated output.** Regenerate from the source instead:

| Generated                        | Regenerate with                                       |
| -------------------------------- | ----------------------------------------------------- |
| `shared/types/ipc/generated*.ts` | `npm run codegen:ipc && npm run codegen:ipc-renderer` |
| `docs/keyboard-shortcuts.md`     | `npm run codegen:keybindings`                         |
| drizzle migrations               | `npm run db:generate`                                 |
| assistant prompts                | `npm run build:assistant`                             |

Ten ratchet baselines live in `scripts/baselines/` — **regenerate the baseline, never hand-edit the JSON**: `lint:ratchet` (eslint warnings), `e2e-waits` (unannotated `waitForTimeout` / `isVisible({ timeout })` in E2E specs), `compiler-budget` (React Compiler bailouts), `import-budget`, `renderer-import-budget`, `renderer-bundle-budget`, `first-render-chunk-budget`, `test-ratio`, `check:ipc-handwritten`, `theme:text-ramp`. Seven have matching `*:check`/`*:update` scripts; three do not — update `lint:ratchet` with `-- --update`, `check:ipc-handwritten` via `ipc-handwritten:update`, and `theme:text-ramp` with `-- --check` / `-- --plan` (`--plan` rewrites the manifest).

Only `lint:ratchet`, `e2e-waits:check` and `check:ipc-handwritten` run inside `npm run check`; the budget scripts are deliberately out of CI pre-1.0. The lint ratchet gates **per-rule as well as in total**, and a rule vanishing from live output is a hard failure — so you cannot silence a rule in config to get under the gate.

Never widen a baseline to make a change pass.
