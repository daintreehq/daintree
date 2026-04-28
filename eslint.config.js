import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactCompiler from "eslint-plugin-react-compiler";
import unicorn from "eslint-plugin-unicorn";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended rules
  ...tseslint.configs.recommended,

  // Downgrade new ESLint 10 recommended rules to warnings (ratcheted)
  {
    rules: {
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
    },
  },

  // React Hooks configuration
  {
    files: ["**/*.{tsx,jsx,ts}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      // React Hooks rules
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // TypeScript-specific rules
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Allow unused vars prefixed with underscore
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Allow explicit any for now (can tighten later)
      "@typescript-eslint/no-explicit-any": "warn",

      // Allow non-null assertions (common in Electron IPC)
      "@typescript-eslint/no-non-null-assertion": "off",

      // Allow empty functions (common for cleanup callbacks)
      "@typescript-eslint/no-empty-function": "off",

      // Prefer const assertions
      "@typescript-eslint/prefer-as-const": "error",
    },
  },

  // Electron main process specific rules
  {
    files: ["electron/**/*.ts"],
    rules: {
      // Console is allowed in main process
      "no-console": "off",
    },
  },

  // Layering rules - prevent architecture violations
  {
    files: ["src/store/**/*.ts"],
    rules: {
      // Stores should not import IPC clients directly - use controllers
      "no-restricted-imports": [
        "warn",
        {
          paths: [
            {
              name: "@/clients/terminalClient",
              message:
                "Store files should not import IPC clients directly. Use controllers to encapsulate IPC calls.",
            },
          ],
          patterns: [
            {
              group: ["@/clients"],
              message:
                "Store files should not import IPC clients directly. Use controllers to encapsulate IPC calls.",
            },
          ],
        },
      ],
    },
  },

  // React Compiler — surface bailout patterns
  {
    files: ["**/*.{tsx,jsx,ts}"],
    plugins: {
      "react-compiler": reactCompiler,
    },
    rules: {
      "react-compiler/react-compiler": "warn",
    },
  },

  // Expiring TODOs — new `TODO [>=X.Y.Z]: ...` syntax fails lint once the
  // package version catches up. Uses bracket syntax so it does not collide
  // with existing `TODO(0.9.0)` parenthesis-format comments owned by #5150.
  {
    files: ["**/*.{ts,tsx,js,jsx,cts,mts}"],
    plugins: {
      unicorn,
    },
    rules: {
      "unicorn/expiring-todo-comments": ["error", { ignoreDatesOnPullRequests: true }],
    },
  },

  // Ban the ad-hoc `err instanceof Error ? err.message : <fallback>` ternary —
  // use formatErrorMessage(err, "domain fallback") from shared/utils/errorMessage
  // so every call site supplies its own operation-specific fallback string.
  // See issue #5845.
  // Also ban `void window.electron.X()` — fire-and-forget IPC must route
  // through safeFireAndForget so rejections reach reportRendererGlobalError
  // with call-site context. See issue #6029.
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ConditionalExpression[test.type='BinaryExpression'][test.operator='instanceof'][test.right.name='Error'][consequent.type='MemberExpression'][consequent.property.name='message']",
          message:
            "Use formatErrorMessage(err, 'operation-specific fallback') from @shared/utils/errorMessage instead of the inline `instanceof Error ? .message : ...` ternary.",
        },
        {
          // why: real IPC calls are `void window.electron.namespace.method()`
          // at any depth. Constraining to `> MemberExpression :has(...)`
          // restricts the descendant search to the callee chain so this
          // doesn't false-positive on `void (async () => { await
          // window.electron.X() })()` IIFE patterns where window.electron
          // appears in the function body, not the callee.
          selector:
            "UnaryExpression[operator='void'] > CallExpression > MemberExpression:has(MemberExpression[object.name='window'][property.name='electron'])",
          message:
            "Don't use `void window.electron.X()` for fire-and-forget IPC — wrap the promise in safeFireAndForget(promise, { context }) from @/utils/safeFireAndForget so rejections reach reportRendererGlobalError with call-site context.",
        },
        {
          // Block raw `error.message` / `err.message` / `e.message` /
          // `result.error.message` inside notify({...}) /
          // addNotification({...}) message properties. These calls go to
          // user-facing toasts; raw library messages leak jargon (paths,
          // errno strings, internal source IDs). Use humanizeAppError()
          // from @shared/utils/errorMessage instead.
          //
          // The selector must match both bare-identifier calls
          // (`notify({...})`) and member-call patterns
          // (`useNotificationStore.getState().addNotification({...})`),
          // hence the `:matches()` over `callee.name` and
          // `callee.property.name`. The inner MemberExpression matches both
          // single-hop (`error.message`) and tail-of-chain (`x.error.message`).
          // See issue #6050.
          selector:
            "CallExpression:matches([callee.name=/^(notify|addNotification)$/], [callee.property.name=/^(notify|addNotification)$/]) ObjectExpression > Property[key.name='message'] MemberExpression[property.name='message']:matches([object.name=/^(error|err|e)$/], [object.property.name=/^(error|err|e)$/])",
          message:
            "Don't pipe raw error.message into user-facing notifications. Use humanizeAppError(error) from @shared/utils/errorMessage to produce a friendly title and body, and stash the raw message in a 'Copy details' action. See #6050.",
        },
      ],
    },
  },

  // Catch un-awaited promises in renderer code. `safeFireAndForget` is the
  // sanctioned escape hatch for fire-and-forget IPC — see issue #6029.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // why: ratcheting plan from #6029 — start at `warn` to surface the
      // remaining bare orphan promise calls (settings hydrators, lazy
      // preloads, store actions) without breaking CI, then ratchet to
      // `error` once the codebase is swept. `ignoreVoid: true` keeps the
      // explicit `void X()` escape hatch available for non-IPC fire-and-
      // forget; `no-restricted-syntax` above bans `void window.electron.*`
      // at error so IPC calls are forced through `safeFireAndForget`.
      "@typescript-eslint/no-floating-promises": [
        "warn",
        {
          ignoreVoid: true,
          allowForKnownSafeCalls: [{ from: "file", name: "safeFireAndForget" }],
        },
      ],
    },
  },

  // Prevent UI components from importing main-process types
  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["electron/**", "**/electron/**"],
              message: "UI components should not import from electron main process modules.",
            },
          ],
        },
      ],
    },
  },

  // Prettier must be last to override conflicting rules
  prettier,

  // Global ignores
  {
    ignores: [
      "dist/**",
      "dist-electron/**",
      "release/**",
      "node_modules/**",
      "*.config.js",
      "*.config.cjs",
      // why: knip.config.ts is a tooling file not covered by any project
      // tsconfig. Scope the TS-config ignore narrowly so vite/vitest/
      // playwright configs remain linted.
      "knip.config.ts",
      "scripts/**",
      "build/**",
      "public/**",
    ],
  }
);
