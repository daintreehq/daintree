---
paths:
  - "src/**/*.{ts,tsx}"
  - "plugins/builtin/*/renderer/**/*.{ts,tsx}"
  - "packages/tour/src/**/*.{ts,tsx}"
  - "vite.config.ts"
---

# React Compiler

React Compiler is enabled (`babel-plugin-react-compiler`, `target: "19"`). A bailout is silent at runtime but reddens `compiler-budget`; `docs/development.md` has the diagnosis tooling.
