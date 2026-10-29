---
paths:
  - "plugins/**"
  - "packages/**"
  - "electron/services/plugin*/**"
  - "electron/services/Plugin*.ts"
  - "src/panels/**"
  - "shared/types/panel.ts"
  - "shared/config/panelKindRegistry.ts"
  - "docs/plugins/**"
  - "src/services/plugin/**"
  - "src/hooks/usePlugin*.ts"
  - "src/hooks/app/usePlugin*.{ts,tsx}"
  - "src/store/plugin*.ts"
  - "src/store/*Plugin*.ts"
  - "src/clients/plugin*.ts"
  - "shared/types/plugin*.ts"
  - "shared/config/plugin*.ts"
---

# Plugins and panels

Plugins are manifest-driven, activate out-of-process in unsandboxed `utilityProcess.fork` workers (builtins are the exception and load in-process), and contribute actions, panels, agents, toolbar buttons, and forge providers under capability + consent gating. GitHub ships as a builtin forge plugin (`plugins/builtin/github`) so the host stays forge-neutral. Author SDK = the `packages/*` npm workspace (`npm run packages:build`).

**Vanilla Daintree pays nothing for plugins:** with no consumer, a plugin capability costs nothing at runtime (`docs/plugins/architecture.md`, "Vanilla install and the cheap empty path").

There are seven built-in panel kinds (`terminal`, `browser`, `dev-preview`, `review`, `file`, `file-browser`, `diff`), defined by `BUILT_IN_PANEL_KINDS` in `shared/config/panelKindRegistry.ts`, with per-kind modules in `src/panels/<kind>/`. `PanelKind` in `shared/types/panel.ts` also accepts plugin-defined strings.
