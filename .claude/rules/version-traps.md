---
paths:
  - "package.json"
  - "electron/**/*.ts"
  - "src/services/terminal/**"
  - "src/components/Terminal/**"
  - "vite.config.*"
---

# Version traps

Research against the exact pinned versions in `package.json` — never assume older docs apply.

- **Electron 42:** unsigned macOS notifications silently emit `failed`; `Session.clearStorageData` drops `quotas`.
- **xterm 6.x:** the canvas renderer, `windowsMode` and `fastScrollModifier` are all removed; new event system.
- **Vite** is pinned `~8.0.14` on purpose: 8.1.x changes chunk faceting so `LazyMotion` never initialises and boot dies. Don't bump it casually.
- **TypeScript:** `typescript7` supplies the TS7 native compiler that typecheck runs on; `typescript` intentionally stays on TS6 for typescript-eslint.
- Tailwind v4 `color-mix()` alpha semantics: see the design-system rule.
