import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactCompiler from "eslint-plugin-react-compiler";
import unicorn from "eslint-plugin-unicorn";
import prettier from "eslint-config-prettier";
import structuredTestSkipAnnotations from "./scripts/eslint-rules/structured-test-skip-annotations.js";
import iconOpacityDimming from "./scripts/eslint-rules/icon-opacity-dimming.js";

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
  // Also ban bare `dangerouslySetInnerHTML` — Trusted Types CSP requires the
  // `__html` value to be a `TrustedHTML` from the daintree-svg policy. See
  // issue #6392.
  // Note: the renderer block below re-declares no-restricted-syntax at "warn"
  // level for src/** with additional selectors. That block's array is the
  // effective set for src/ files, so it must keep these selectors in sync.
  // Renderer-only selectors (notify({type:"error",priority:"low"}) — #6885;
  // Math.random in template literals; magic setTimeout/setInterval delays)
  // intentionally live ONLY in the renderer block since their call sites are
  // renderer-only — duplicating into the global block would add no coverage.
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
        {
          // why: Trusted Types CSP (`require-trusted-types-for 'script'`)
          // means `dangerouslySetInnerHTML.__html` must be a `TrustedHTML`
          // produced by the `daintree-svg` policy, not a raw string. The
          // selector requires SOME CallExpression in the value (lint-level
          // ratchet — the runtime CSP is the actual security boundary, and
          // a stricter `callee.name='createTrustedHTML'` check breaks under
          // re-exports / aliasing). See #6392.
          selector:
            "JSXAttribute[name.name='dangerouslySetInnerHTML'] > JSXExpressionContainer > ObjectExpression > Property[key.name='__html']:not(:has(CallExpression))",
          message:
            "Pass __html through createTrustedHTML(value) from @/lib/trustedTypesPolicy instead of a raw string. See #6392.",
        },
        {
          // why: ZodError.flatten() and .format() instance methods are
          // deprecated in Zod 4 and slated for removal in Zod 5. Anchored on
          // an object named `error` / `err` (single-hop bare ident or tail
          // of a chain like `result.error.flatten()`) so this does not
          // collide with Array.prototype.flat() or String.prototype.format.
          // See #8566.
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(flatten|format)$/]:matches([callee.object.property.name=/^(error|err)$/], [callee.object.name=/^(error|err)$/])",
          message:
            "Use z.flattenError(err) (shape-consuming) or z.prettifyError(err) (log-only) instead of deprecated ZodError instance methods .flatten() / .format(). See #8566.",
        },
        {
          // why: values written via Sentry scope setters land in
          // event.tags/user/contexts. sanitizeEvent deep-walks those fields,
          // but centralizing setter call sites in TelemetryService.ts keeps
          // every injection point reviewable against the scrubbing contract.
          // Matches member calls (Sentry.setTag, sentryModule?.setTag,
          // scope.setUser) and bare named-import calls. See #10047.
          selector:
            "CallExpression:matches([callee.type='MemberExpression'][callee.property.name=/^(setTag|setUser|setContext)$/], [callee.type='Identifier'][callee.name=/^(setTag|setUser|setContext)$/])",
          message:
            "Sentry scope setters (setTag/setUser/setContext) are centralized in TelemetryService.ts so every value entering event.tags/user/contexts stays within the scrubbing contract. Annotate a legitimate site with `// eslint-disable-next-line no-restricted-syntax -- sentry-scope-setter: ok` plus a rationale. See #10047.",
        },
      ],
    },
  },

  // Panel-kind literal-compare guardrail — ratchets on shared/ and electron/
  // at warn level. src/ coverage lives in the renderer hygiene block below
  // (also warn, to keep the ratchet consistent across the tree).
  //
  // This block also replicates the 4 global no-restricted-syntax selectors
  // (instanceof Error ternary, void window.electron, raw error.message in
  // notify, dangerouslySetInnerHTML) because flat config is last-write-wins
  // per rule — without them the global error-level selectors are silently
  // dropped for shared/ and electron/ files.
  // See #7672.
  {
    files: ["shared/**/*.{ts,tsx}", "electron/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "warn",
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
        {
          // why: Trusted Types CSP (`require-trusted-types-for 'script'`)
          // means `dangerouslySetInnerHTML.__html` must be a `TrustedHTML`
          // produced by the `daintree-svg` policy, not a raw string. The
          // selector requires SOME CallExpression in the value (lint-level
          // ratchet — the runtime CSP is the actual security boundary, and
          // a stricter `callee.name='createTrustedHTML'` check breaks under
          // re-exports / aliasing). See #6392.
          selector:
            "JSXAttribute[name.name='dangerouslySetInnerHTML'] > JSXExpressionContainer > ObjectExpression > Property[key.name='__html']:not(:has(CallExpression))",
          message:
            "Pass __html through createTrustedHTML(value) from @/lib/trustedTypesPolicy instead of a raw string. See #6392.",
        },
        {
          // why: direct literal compares (kind === "browser") bypass the
          // panel-kind registry and silently diverge when capability flags
          // change. Use registry helpers (panelKindHasPty, etc.) or the
          // sanctioned type guards (isPtyPanel, isBrowserPanel,
          // isDevPreviewPanel) from @shared/types/panel. See #7672.
          selector:
            "BinaryExpression[operator=/^(!==|===)$/]:matches([left.name='kind'], [left.property.name='kind'])[right.type='Literal'][right.value=/^(terminal|browser|dev-preview)$/]",
          message:
            "Don't compare panel.kind against string literals. Use registry helpers (panelKindHasPty, panelKindCanRestart) or sanctioned type guards (isPtyPanel, isBrowserPanel, isDevPreviewPanel) from @shared/types/panel. See #7672.",
        },
        {
          // why: ZodError.flatten() and .format() instance methods are
          // deprecated in Zod 4 and slated for removal in Zod 5. Anchored on
          // an object named `error` / `err` (single-hop bare ident or tail
          // of a chain like `result.error.flatten()`) so this does not
          // collide with Array.prototype.flat() or String.prototype.format.
          // See #8566.
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(flatten|format)$/]:matches([callee.object.property.name=/^(error|err)$/], [callee.object.name=/^(error|err)$/])",
          message:
            "Use z.flattenError(err) (shape-consuming) or z.prettifyError(err) (log-only) instead of deprecated ZodError instance methods .flatten() / .format(). See #8566.",
        },
        {
          // why: electron-updater's AppUpdater.channel setter unconditionally
          // flips allowDowngrade=true on every assignment, silently stranding
          // the stable-channel rollback guard from #7573. AutoUpdaterService
          // routes channel changes through setFeedURL() + an explicit
          // allowDowngrade assignment for this reason. Matches dot and bracket
          // notation; aliased writes (`const u = autoUpdater; u.channel = …`)
          // are out of scope — the direct form is the accidental drift path.
          // See #9123.
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.name='autoUpdater']:matches([left.property.name='channel'], [left.property.value='channel'])",
          message:
            "Don't assign to autoUpdater.channel directly — the setter unconditionally flips allowDowngrade=true, silently breaking the stable-channel rollback guard from #7573. Route channel changes through AutoUpdaterService (setFeedURL + explicit allowDowngrade). See #9123.",
        },
        {
          // Mirrored from the global block (flat-config last-write-wins).
          // See #10047.
          selector:
            "CallExpression:matches([callee.type='MemberExpression'][callee.property.name=/^(setTag|setUser|setContext)$/], [callee.type='Identifier'][callee.name=/^(setTag|setUser|setContext)$/])",
          message:
            "Sentry scope setters (setTag/setUser/setContext) are centralized in TelemetryService.ts so every value entering event.tags/user/contexts stays within the scrubbing contract. Annotate a legitimate site with `// eslint-disable-next-line no-restricted-syntax -- sentry-scope-setter: ok` plus a rationale. See #10047.",
        },
      ],
    },
  },

  // Enforce property syntax on interface method signatures to preserve
  // function parameter contravariance under strictFunctionTypes. Method
  // syntax is bivariant and would silently accept unsafe widening casts.
  // See #8961.
  {
    files: ["shared/config/**/*.ts"],
    rules: {
      "@typescript-eslint/method-signature-style": ["error", "property"],
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

  // Renderer hygiene ratchets — typed rules require a project-aware parser so
  // we scope `projectService` to `src/**` (electron/ has its own tsconfig and
  // would error out under this parser). Issue #5975.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Force structured logger usage in the renderer. console.warn is allowed
      // for breadcrumbs that don't need IPC; bootstrap/error-fallback paths
      // suppress with `// eslint-disable-next-line no-console` and a comment.
      "no-console": ["error", { allow: ["warn"] }],

      // Flag narrowing assertions (`value as Foo` where value is any/unknown).
      // Broadening assertions (`value as unknown`) are still allowed.
      "@typescript-eslint/no-unsafe-type-assertion": "warn",

      // Renderer-scoped no-restricted-syntax. Flat-config is last-write-wins per
      // rule, so this array fully overrides the global block above for src/
      // files — selectors from the global block are repeated here to preserve
      // coverage, plus renderer-only selectors for Math.random IDs and magic
      // numeric setTimeout/setInterval delays.
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "ConditionalExpression[test.type='BinaryExpression'][test.operator='instanceof'][test.right.name='Error'][consequent.type='MemberExpression'][consequent.property.name='message']",
          message:
            "Use formatErrorMessage(err, 'operation-specific fallback') from @shared/utils/errorMessage instead of the inline `instanceof Error ? .message : ...` ternary.",
        },
        {
          selector:
            "UnaryExpression[operator='void'] > CallExpression > MemberExpression:has(MemberExpression[object.name='window'][property.name='electron'])",
          message:
            "Don't use `void window.electron.X()` for fire-and-forget IPC — wrap the promise in safeFireAndForget(promise, { context }) from @/utils/safeFireAndForget so rejections reach reportRendererGlobalError with call-site context.",
        },
        {
          selector:
            "CallExpression:matches([callee.name=/^(notify|addNotification)$/], [callee.property.name=/^(notify|addNotification)$/]) ObjectExpression > Property[key.name='message'] MemberExpression[property.name='message']:matches([object.name=/^(error|err|e)$/], [object.property.name=/^(error|err|e)$/])",
          message:
            "Don't pipe raw error.message into user-facing notifications. Use humanizeAppError(error) from @shared/utils/errorMessage to produce a friendly title and body, and stash the raw message in a 'Copy details' action. See #6050.",
        },
        {
          // why: type:"error" + priority:"low" silently drops the error
          // into the history inbox with no toast — users won't see it. If
          // the failure is diagnostic-only (user can still finish their
          // current task) demote to console.warn; if users need to see it,
          // remove priority:"low" or raise to "high"/"normal". Direct-child
          // combinator inside :has() prevents false positives from nested
          // sub-objects (e.g. context payloads). Literal-only match — the
          // computed-priority pattern in useErrors.ts is intentionally out
          // of scope. See #6885.
          selector:
            "CallExpression:matches([callee.name=/^(notify|addNotification)$/], [callee.property.name=/^(notify|addNotification)$/]) > ObjectExpression:has(> Property[key.name='type'][value.value='error']):has(> Property[key.name='priority'][value.value='low'])",
          message:
            'Don\'t emit low-priority error notifications. Use console.warn for diagnostic-only failures (user can still finish their task), or remove priority:"low" so the error toasts. See #6885.',
        },
        {
          // why: type:"error" notifications without an action leave users with
          // no recovery path — they're shouting "something broke" with no
          // next step. Title-Message-Action is the CLAUDE.md contract. If the
          // surrounding UI is itself the recovery surface (form stays open,
          // user can retry from within the page) annotate with
          // `// eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok`
          // so the deliberate choice is documented. Direct-child combinator
          // inside :has() matches the priority:"low" rule pattern above and
          // prevents false positives from nested sub-objects. Known gap: a
          // spread-only action (`notify({ type:"error", ...recovery })` where
          // `recovery` includes `action`) will false-positive — refactor to
          // an inline `action:` property at the call site if you hit it. See
          // #8097.
          selector:
            "CallExpression:matches([callee.name=/^(notify|addNotification)$/], [callee.property.name=/^(notify|addNotification)$/]) > ObjectExpression:has(> Property[key.name='type'][value.value='error']):not(:has(> Property[key.name='action'])):not(:has(> Property[key.name='actions']))",
          message:
            "Action-free error notification. Either wire an action: { label, onClick } (Title-Message-Action contract), or annotate with `// eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok` when the surrounding UI is itself the recovery surface. See #8097.",
        },
        {
          // why: success toasts are the most over-used severity — they fire
          // on routine in-place state changes the user can already see (form
          // saves, panel docks, undo confirmations). Per CLAUDE.md's notify
          // four-question gate, a success toast is justified only when at
          // least one of three escape hatches is present: `transient: true`
          // (one-shot, no inbox row written — fine for ambient confirmations
          // whose recovery surface is the UI itself), `priority: "low"`
          // (history-only, no toast — fine for background completions), or
          // a `correlationId` (the success threads into an existing
          // notification group — fine for stateful flows like update-check).
          // If none apply, demote: either drop the notify entirely (the
          // in-place UI change is the signal) or wire one of the three opts.
          // Opt out with `// eslint-disable-next-line no-restricted-syntax
          // -- notify-no-action: ok` when the call is deliberate. Direct-
          // child combinator inside :has() prevents nested-sub-object false
          // positives, matching the error-low and action-free-error rules
          // above. See #8249.
          selector:
            "CallExpression:matches([callee.name=/^(notify|addNotification)$/], [callee.property.name=/^(notify|addNotification)$/]) > ObjectExpression:has(> Property[key.name='type'][value.value='success']):not(:has(> Property[key.name='transient'][value.value=true])):not(:has(> Property[key.name='priority'][value.value='low'])):not(:has(> Property[key.name='correlationId']))",
          message:
            'Unprotected success toast. Success is over-used — fires on routine in-place state changes users can already see. Add one of: `transient: true` (one-shot, no inbox row), `priority: "low"` (history-only), or a `correlationId` (threads into an existing notification group). Or annotate with `// eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok` when the call is deliberate. See #8249.',
        },
        {
          // why: routing each notify() through the EVENT_POLICY manifest needs a
          // `context.eventKind` so the dispatcher can resolve priority/placement/
          // duration centrally instead of re-deriving them per call site. Flags
          // inline-literal notify()/addNotification() calls missing
          // context.eventKind. Skips spread-bearing payloads (`notify({
          // ...payload })`) and variable-reference contexts (`context: ctxVar`)
          // since neither can be statically verified — those plus the ~74 legacy
          // sites annotate with `// eslint-disable-next-line no-restricted-syntax
          // -- notify-event-kind: ok` until migrated. See #9007.
          // NOTE: the eventKind `:has()` clause intentionally omits the leading
          // `>` before the `context` property — esquery in this version
          // mishandles a child combinator followed by a descendant chain inside
          // `:has(> A > B > C)`, silently matching nothing. The SpreadElement and
          // Identifier-context guards keep their `>` since they're single-level.
          selector:
            "CallExpression:matches([callee.name=/^(notify|addNotification)$/], [callee.property.name=/^(notify|addNotification)$/]) > ObjectExpression:not(:has(> SpreadElement)):not(:has(Property[key.name='context'] > ObjectExpression > Property[key.name='eventKind'])):not(:has(> Property[key.name='context'][value.type='Identifier']))",
          message:
            'notify() call missing context.eventKind — add `context: { eventKind: "<kind>" }` so EVENT_POLICY can route it, or annotate with `// eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok` for legacy sites. See #9007.',
        },
        {
          selector:
            "JSXAttribute[name.name='dangerouslySetInnerHTML'] > JSXExpressionContainer > ObjectExpression > Property[key.name='__html']:not(:has(CallExpression))",
          message:
            "Pass __html through createTrustedHTML(value) from @/lib/trustedTypesPolicy instead of a raw string. See #6392.",
        },
        {
          selector:
            "TemplateLiteral CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            "Don't construct IDs from `Math.random()` inside template literals. Use crypto.randomUUID() (or a deterministic counter in tests) — Math.random() collides and isn't cryptographically random.",
        },
        {
          selector:
            "CallExpression[callee.type='Identifier'][callee.name=/^(setTimeout|setInterval)$/][arguments.1.type='Literal'][arguments.1.value>0]",
          message:
            "Avoid magic numeric delays. Hoist the value into a named constant (e.g. `const FLUSH_INTERVAL_MS = 200`) so the intent is documented at the call site.",
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(setTimeout|setInterval)$/][arguments.1.type='Literal'][arguments.1.value>0]",
          message:
            "Avoid magic numeric delays. Hoist the value into a named constant (e.g. `const FLUSH_INTERVAL_MS = 200`) so the intent is documented at the call site.",
        },
        {
          // why: direct literal compares (kind === "browser") bypass the
          // panel-kind registry and silently diverge when capability flags
          // change. Use registry helpers (panelKindHasPty, etc.) or the
          // sanctioned type guards (isPtyPanel, isBrowserPanel,
          // isDevPreviewPanel) from @shared/types/panel. See #7672.
          selector:
            "BinaryExpression[operator=/^(!==|===)$/]:matches([left.name='kind'], [left.property.name='kind'])[right.type='Literal'][right.value=/^(terminal|browser|dev-preview)$/]",
          message:
            "Don't compare panel.kind against string literals. Use registry helpers (panelKindHasPty, panelKindCanRestart) or sanctioned type guards (isPtyPanel, isBrowserPanel, isDevPreviewPanel) from @shared/types/panel. See #7672.",
        },
        {
          selector:
            "CallExpression[callee.object.name='actionService'][callee.property.name='dispatch'] Property[key.name='source'][value.value='context-menu']",
          message:
            'Don\'t hardcode source:"context-menu" in actionService.dispatch calls. Derive it from React Context via useMenuActionSource() from @/components/ui/menu-source. Suppress with // eslint-disable-next-line no-restricted-syntax -- context-menu-source: ok when the dispatch lives outside a ContextMenu/DropdownMenu Root. See #8322.',
        },
        {
          // why: ZodError.flatten() and .format() instance methods are
          // deprecated in Zod 4 and slated for removal in Zod 5. Anchored on
          // an object named `error` / `err` (single-hop bare ident or tail
          // of a chain like `result.error.flatten()`) so this does not
          // collide with Array.prototype.flat() or String.prototype.format.
          // See #8566.
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(flatten|format)$/]:matches([callee.object.property.name=/^(error|err)$/], [callee.object.name=/^(error|err)$/])",
          message:
            "Use z.flattenError(err) (shape-consuming) or z.prettifyError(err) (log-only) instead of deprecated ZodError instance methods .flatten() / .format(). See #8566.",
        },
        {
          // Mirrored from the global block (flat-config last-write-wins).
          // See #10047.
          selector:
            "CallExpression:matches([callee.type='MemberExpression'][callee.property.name=/^(setTag|setUser|setContext)$/], [callee.type='Identifier'][callee.name=/^(setTag|setUser|setContext)$/])",
          message:
            "Sentry scope setters (setTag/setUser/setContext) are centralized in TelemetryService.ts so every value entering event.tags/user/contexts stays within the scrubbing contract. Annotate a legitimate site with `// eslint-disable-next-line no-restricted-syntax -- sentry-scope-setter: ok` plus a rationale. See #10047.",
        },
        {
          // why: passive eventKinds (uiFeedback, workingPulse, settings) resolve
          // to priority:"low" via resolveEventPolicyDefaults() when the caller
          // omits priority. Combined with transient:true this is a silent no-op:
          // low priority skips the toast and transient skips the inbox, so the
          // notification fires nowhere. Add an explicit priority:"high" to
          // override the passive policy default. See #10051.
          // NOTE: the eventKind `:has()` clause omits the leading `>` before the
          // `context` property for the same esquery reason as the
          // notify-event-kind rule above; the transient/priority guards keep
          // their `>` since they're single-level top-of-payload properties.
          selector:
            "CallExpression:matches([callee.name=/^(notify|addNotification)$/], [callee.property.name=/^(notify|addNotification)$/]) > ObjectExpression:has(> Property[key.name='transient'][value.value=true]):has(Property[key.name='context'] > ObjectExpression > Property[key.name='eventKind'][value.value=/^(uiFeedback|workingPulse|settings)$/]):not(:has(> Property[key.name='priority']))",
          message:
            'Passive eventKind (uiFeedback/workingPulse/settings) + transient:true is a silent no-op — priority resolves to "low" (inbox-only) and transient skips the inbox, so the notification fires nowhere. Add an explicit priority:"high" to override the policy default, or annotate with `// eslint-disable-next-line no-restricted-syntax -- notify-passive-transient: ok` for a deliberate exception. See #10051.',
        },
      ],
    },
  },

  // Logger module is the fallback console sink — its console.* calls are
  // intentional and must be allowed.
  {
    files: ["src/utils/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // Renderer import discipline — bans heavy bundle-cost packages from being
  // statically imported into the eager graph, plus the long-standing
  // electron-module ban (previously scoped to src/components/**, broadened
  // here to src/** since flat config is last-write-wins per rule and merging
  // the two restrictions avoids silently clobbering the electron guard). The
  // per-file override blocks below allowlist the small set of files where the
  // static import is genuinely required today; those overrides disable the
  // rule entirely for the scoped files, which is the only flat-config
  // mechanism since arrays don't merge.
  //
  // Pair with the renderer-import budget gate (scripts/check-renderer-import-budget.mjs)
  // which catches new chunks slipping into the eager closure even when the
  // lint rule is silenced by an allowlist entry. See issue #7659.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          paths: [
            {
              name: "@uiw/react-codemirror",
              message:
                "Heavy package — lazy-load via React.lazy() or dynamic import to keep the renderer eager graph trim. If a static import is genuinely required, add this file to the per-file override allowlist in eslint.config.js. See #7659.",
            },
            {
              name: "framer-motion",
              message:
                "Heavy package — lazy-load via React.lazy() or dynamic import. Animation features are already split via loadMotionFeatures(); prefer that pattern. See #7659.",
            },
            {
              name: "react-diff-view",
              message: "Heavy package — lazy-load via React.lazy() or dynamic import. See #7659.",
            },
            {
              name: "@/clients/githubClient",
              message:
                "githubClient is restricted to an allowlist. Use forgeClient for provider-neutral operations or dispatch forge.* actions via actionService. If this import is genuinely GitHub-specific, add the file to the allowlist in githubActions.adversarial.test.ts. See #8460.",
            },
            {
              name: "@/clients",
              importNames: ["githubClient"],
              message:
                "Importing githubClient from the barrel is restricted. If this file is in the allowlist, import from @/clients/githubClient directly. Otherwise use forgeClient or dispatch forge.* actions. See #8460.",
            },
          ],
          patterns: [
            {
              group: ["@radix-ui/*"],
              message:
                "Heavy package — wrap radix primitives in lazy-loaded components or compose them inside an already lazy boundary. See #7659.",
            },
            {
              group: ["@codemirror/*"],
              message:
                "Heavy package — codemirror modules should sit behind a lazy boundary (terminal input editor and file viewer are the canonical eager call sites; add new files to the allowlist if a static import is genuinely required). See #7659.",
            },
            {
              group: ["electron/**", "**/electron/**"],
              message: "Renderer code should not import from electron main process modules.",
            },
          ],
        },
      ],
    },
  },

  // Allowlist — framer-motion animation infrastructure and root App bootstrap.
  // App.tsx mounts LazyMotion + MotionConfig; motionFeatures.ts is the lazy
  // feature loader; animationUtils.ts exports the shared timing constants.
  {
    files: ["src/App.tsx", "src/lib/motionFeatures.ts", "src/lib/animationUtils.ts"],
    rules: { "no-restricted-imports": "off" },
  },

  // Allowlist — framer-motion drag-and-drop chrome (eager grid layout).
  {
    files: ["src/components/DragDrop/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },

  // Allowlist — framer-motion panel tab list animations.
  {
    files: [
      "src/components/Panel/PanelTabList.tsx",
      "src/components/Panel/SortableTabButton.tsx",
      "src/components/Panel/TabButton.tsx",
    ],
    rules: { "no-restricted-imports": "off" },
  },

  // Allowlist — framer-motion content grid animations (terminal layout).
  {
    files: [
      "src/components/Terminal/ContentGridDefault.tsx",
      "src/components/Terminal/ContentGridFleetScope.tsx",
      "src/components/Terminal/useContentGridContext.tsx",
    ],
    rules: { "no-restricted-imports": "off" },
  },

  // Allowlist — framer-motion GitHub, Fleet, Layout chrome.
  {
    files: [
      "src/components/GitHub/BulkActionBar.tsx",
      "src/components/GitHub/CommitList.tsx",
      "src/components/GitHub/GitHubResourceList.tsx",
      "src/components/Fleet/FleetArmingRibbon.tsx",
      "src/components/Layout/DockedTabGroup.tsx",
    ],
    rules: { "no-restricted-imports": "off" },
  },

  // Allowlist — framer-motion onboarding/setup surfaces.
  {
    files: [
      "src/components/Onboarding/**/*.{ts,tsx}",
      "src/components/Setup/AgentSetupWizard.tsx",
      "src/components/Setup/SystemRequirementsSection.tsx",
      "src/components/Worktree/WorktreeCard/WorktreeDetailsSection.tsx",
      "src/hooks/app/useGettingStartedChecklist.ts",
    ],
    rules: { "no-restricted-imports": "off" },
  },

  // Allowlist — codemirror terminal input editor and its hook tree.
  {
    files: [
      "src/components/Terminal/HybridInputBar.tsx",
      "src/components/Terminal/hooks/**/*.{ts,tsx}",
      "src/components/Terminal/inputEditorExtensions/**/*.{ts,tsx}",
      "src/store/terminalInputStore.ts",
    ],
    rules: { "no-restricted-imports": "off" },
  },

  // Allowlist — codemirror file viewer and demo cursor.
  {
    files: [
      "src/components/FileViewer/CodeViewer.tsx",
      "src/components/FileViewer/codeMirrorLanguages.ts",
      "src/components/FileViewer/editorSearchTheme.ts",
      "src/components/Demo/DemoCursor.tsx",
    ],
    rules: { "no-restricted-imports": "off" },
  },

  // Allowlist — react-diff-view file viewer and worktree diff (DiffViewer's
  // helper modules live in the same lazy chunk; diffTokenizer is also the
  // diff-tokenize worker's entrypoint into react-diff-view, bundled separately).
  {
    files: [
      "src/components/FileViewer/FileViewerModal.tsx",
      "src/components/Worktree/DiffViewer.tsx",
      "src/components/Worktree/diffEditSuppression.ts",
      "src/components/Worktree/diffMovedUtils.ts",
      "src/components/Worktree/diffTokenRanges.ts",
      "src/components/Worktree/diffTokenizer.ts",
    ],
    rules: { "no-restricted-imports": "off" },
  },

  // Allowlist — radix-ui UI primitives (button, popover, tooltip, etc.) and
  // their direct consumers.
  {
    files: [
      "src/components/ui/button.tsx",
      "src/components/ui/context-menu.tsx",
      "src/components/ui/dropdown-menu.tsx",
      "src/components/ui/popover.tsx",
      "src/components/ui/select.tsx",
      "src/components/ui/tooltip.tsx",
      "src/components/Fleet/FleetPickerContent.tsx",
      "src/components/Settings/DiagnosticsReviewDialog.tsx",
      "src/components/Settings/SettingsCheckbox.tsx",
      "src/components/Settings/SettingsSwitch.tsx",
    ],
    rules: { "no-restricted-imports": "off" },
  },

  // Allowlist — test files exercising heavy-package components. Tests
  // legitimately import the package directly to assert behavior; the
  // production lazy-boundary discipline is enforced on the component, not the
  // test.
  {
    files: ["src/**/__tests__/**/*.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },

  // Block the legacy `typedHandle*` IPC registration helpers from new
  // handler files. The codebase is migrating from typedHandle /
  // typedHandleWithContext / typedHandleValidated / typedHandleWithContextValidated
  // (defined in electron/ipc/utils.ts) to `defineIpcNamespace` (electron/ipc/define.ts).
  // New handler files get a hard error; the existing 62 legacy files get
  // a warn-level override below so they ratchet down via lint-ratchet.mjs.
  //
  // Re-lists all 5 selectors from the shared/**+electron/** warn block
  // (lines 218-287) because flat-config is last-write-wins per rule —
  // without them those guards silently drop for handlers/**. The severity
  // promotion to error is intentional: new handler files should follow
  // the strict global default, and existing handler usages of the 5
  // patterns are either fixed or covered by the warn-level override below.
  // See #8577.
  {
    files: ["electron/ipc/handlers/**/*.ts"],
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
          selector:
            "UnaryExpression[operator='void'] > CallExpression > MemberExpression:has(MemberExpression[object.name='window'][property.name='electron'])",
          message:
            "Don't use `void window.electron.X()` for fire-and-forget IPC — wrap the promise in safeFireAndForget(promise, { context }) from @/utils/safeFireAndForget so rejections reach reportRendererGlobalError with call-site context.",
        },
        {
          selector:
            "CallExpression:matches([callee.name=/^(notify|addNotification)$/], [callee.property.name=/^(notify|addNotification)$/]) ObjectExpression > Property[key.name='message'] MemberExpression[property.name='message']:matches([object.name=/^(error|err|e)$/], [object.property.name=/^(error|err|e)$/])",
          message:
            "Don't pipe raw error.message into user-facing notifications. Use humanizeAppError(error) from @shared/utils/errorMessage to produce a friendly title and body, and stash the raw message in a 'Copy details' action. See #6050.",
        },
        {
          selector:
            "JSXAttribute[name.name='dangerouslySetInnerHTML'] > JSXExpressionContainer > ObjectExpression > Property[key.name='__html']:not(:has(CallExpression))",
          message:
            "Pass __html through createTrustedHTML(value) from @/lib/trustedTypesPolicy instead of a raw string. See #6392.",
        },
        {
          selector:
            "BinaryExpression[operator=/^(!==|===)$/]:matches([left.name='kind'], [left.property.name='kind'])[right.type='Literal'][right.value=/^(terminal|browser|dev-preview)$/]",
          message:
            "Don't compare panel.kind against string literals. Use registry helpers (panelKindHasPty, panelKindCanRestart) or sanctioned type guards (isPtyPanel, isBrowserPanel, isDevPreviewPanel) from @shared/types/panel. See #7672.",
        },
        {
          // Mirrored from the shared/**+electron/** warn block so the
          // handler override doesn't silently drop the guard for handler
          // files (flat-config last-write-wins). See #9123.
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.name='autoUpdater']:matches([left.property.name='channel'], [left.property.value='channel'])",
          message:
            "Don't assign to autoUpdater.channel directly — the setter unconditionally flips allowDowngrade=true, silently breaking the stable-channel rollback guard from #7573. Route channel changes through AutoUpdaterService (setFeedURL + explicit allowDowngrade). See #9123.",
        },
        {
          selector:
            "CallExpression[callee.name=/^(typedHandle|typedHandleWithContext|typedHandleValidated|typedHandleWithContextValidated)$/]",
          message:
            "Don't register IPC handlers with the legacy typedHandle* helpers from electron/ipc/utils. Use `defineIpcNamespace` from electron/ipc/define instead — it gives a single declarative surface for routing, validation, and error handling. See #8577.",
        },
        {
          // Mirrored from the global block (flat-config last-write-wins).
          // See #10047.
          selector:
            "CallExpression:matches([callee.type='MemberExpression'][callee.property.name=/^(setTag|setUser|setContext)$/], [callee.type='Identifier'][callee.name=/^(setTag|setUser|setContext)$/])",
          message:
            "Sentry scope setters (setTag/setUser/setContext) are centralized in TelemetryService.ts so every value entering event.tags/user/contexts stays within the scrubbing contract. Annotate a legitimate site with `// eslint-disable-next-line no-restricted-syntax -- sentry-scope-setter: ok` plus a rationale. See #10047.",
        },
      ],
    },
  },

  // Test-file safety valve for handler tests. Tests legitimately import
  // and call typedHandle* to exercise the legacy code paths; the
  // production gate above is enforced on the handler files, not the
  // tests. Re-lists the 5 inherited selectors at warn and omits the
  // typedHandle* selector. See #8577.
  {
    files: ["electron/ipc/handlers/**/__tests__/**/*.ts", "electron/ipc/handlers/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "ConditionalExpression[test.type='BinaryExpression'][test.operator='instanceof'][test.right.name='Error'][consequent.type='MemberExpression'][consequent.property.name='message']",
          message:
            "Use formatErrorMessage(err, 'operation-specific fallback') from @shared/utils/errorMessage instead of the inline `instanceof Error ? .message : ...` ternary.",
        },
        {
          selector:
            "UnaryExpression[operator='void'] > CallExpression > MemberExpression:has(MemberExpression[object.name='window'][property.name='electron'])",
          message:
            "Don't use `void window.electron.X()` for fire-and-forget IPC — wrap the promise in safeFireAndForget(promise, { context }) from @/utils/safeFireAndForget so rejections reach reportRendererGlobalError with call-site context.",
        },
        {
          selector:
            "CallExpression:matches([callee.name=/^(notify|addNotification)$/], [callee.property.name=/^(notify|addNotification)$/]) ObjectExpression > Property[key.name='message'] MemberExpression[property.name='message']:matches([object.name=/^(error|err|e)$/], [object.property.name=/^(error|err|e)$/])",
          message:
            "Don't pipe raw error.message into user-facing notifications. Use humanizeAppError(error) from @shared/utils/errorMessage to produce a friendly title and body, and stash the raw message in a 'Copy details' action. See #6050.",
        },
        {
          selector:
            "JSXAttribute[name.name='dangerouslySetInnerHTML'] > JSXExpressionContainer > ObjectExpression > Property[key.name='__html']:not(:has(CallExpression))",
          message:
            "Pass __html through createTrustedHTML(value) from @/lib/trustedTypesPolicy instead of a raw string. See #6392.",
        },
        {
          selector:
            "BinaryExpression[operator=/^(!==|===)$/]:matches([left.name='kind'], [left.property.name='kind'])[right.type='Literal'][right.value=/^(terminal|browser|dev-preview)$/]",
          message:
            "Don't compare panel.kind against string literals. Use registry helpers (panelKindHasPty, panelKindCanRestart) or sanctioned type guards (isPtyPanel, isBrowserPanel, isDevPreviewPanel) from @shared/types/panel. See #7672.",
        },
        {
          // Mirrored from the shared/**+electron/** warn block so the
          // handler-test override doesn't silently drop the guard for
          // handler test files (flat-config last-write-wins). See #9123.
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.name='autoUpdater']:matches([left.property.name='channel'], [left.property.value='channel'])",
          message:
            "Don't assign to autoUpdater.channel directly — the setter unconditionally flips allowDowngrade=true, silently breaking the stable-channel rollback guard from #7573. Route channel changes through AutoUpdaterService (setFeedURL + explicit allowDowngrade). See #9123.",
        },
        {
          // Mirrored from the global block (flat-config last-write-wins).
          // See #10047.
          selector:
            "CallExpression:matches([callee.type='MemberExpression'][callee.property.name=/^(setTag|setUser|setContext)$/], [callee.type='Identifier'][callee.name=/^(setTag|setUser|setContext)$/])",
          message:
            "Sentry scope setters (setTag/setUser/setContext) are centralized in TelemetryService.ts so every value entering event.tags/user/contexts stays within the scrubbing contract. Annotate a legitimate site with `// eslint-disable-next-line no-restricted-syntax -- sentry-scope-setter: ok` plus a rationale. See #10047.",
        },
      ],
    },
  },

  // Legacy migration allowlist for #8577. These 62 production handler
  // files were using the legacy typedHandle* registration pattern when
  // the gate landed; their call sites surface as ratchetable warnings
  // via eslint-warnings-baseline.json. Remove a file from this list as
  // it migrates to defineIpcNamespace — do NOT add new files. New
  // handlers must use defineIpcNamespace and stay in the error tier.
  //
  // Explicit named-file list (not glob) so new files added to the same
  // directories land in the error tier automatically. The 6 selectors
  // are re-listed at warn so the 5 inherited guards keep their existing
  // warn-level behavior on these files.
  {
    files: [
      "electron/ipc/handlers/agentCapabilities.ts",
      "electron/ipc/handlers/agentCli.ts",
      "electron/ipc/handlers/ai.ts",
      "electron/ipc/handlers/app/crashRecovery.ts",
      "electron/ipc/handlers/app/gpu.ts",
      "electron/ipc/handlers/app/state.ts",
      "electron/ipc/handlers/appAgent.ts",
      "electron/ipc/handlers/appTheme.ts",
      "electron/ipc/handlers/cli.ts",
      "electron/ipc/handlers/connectivity.ts",
      "electron/ipc/handlers/copyTree.ts",
      "electron/ipc/handlers/diagnostics.ts",
      "electron/ipc/handlers/editorConfig.ts",
      "electron/ipc/handlers/events.ts",
      "electron/ipc/handlers/files.ts",
      "electron/ipc/handlers/forge.ts",
      "electron/ipc/handlers/forgeData.ts",
      "electron/ipc/handlers/forgeSettings.ts",
      "electron/ipc/handlers/gemini.ts",
      "electron/ipc/handlers/git-read.ts",
      "electron/ipc/handlers/git-write.ts",
      "electron/ipc/handlers/github.ts",
      "electron/ipc/handlers/globalRecipes.ts",
      "electron/ipc/handlers/helpAssistant.ts",
      "electron/ipc/handlers/hibernation.ts",
      "electron/ipc/handlers/idleTerminals.ts",
      "electron/ipc/handlers/keybinding.ts",
      "electron/ipc/handlers/logs.ts",
      "electron/ipc/handlers/mcpServer.ts",
      "electron/ipc/handlers/menu.ts",
      "electron/ipc/handlers/milestones.ts",
      "electron/ipc/handlers/notifications.ts",
      "electron/ipc/handlers/onboarding.ts",
      "electron/ipc/handlers/privacy.ts",
      "electron/ipc/handlers/projectCrud/crud.ts",
      "electron/ipc/handlers/projectCrud/gitClone.ts",
      "electron/ipc/handlers/projectCrud/gitInit.ts",
      "electron/ipc/handlers/projectCrud/prefetch.ts",
      "electron/ipc/handlers/projectCrud/settings.ts",
      "electron/ipc/handlers/projectCrud/stats.ts",
      "electron/ipc/handlers/projectCrud/switch.ts",
      "electron/ipc/handlers/projectInRepoSettings.ts",
      "electron/ipc/handlers/projectPresets.ts",
      "electron/ipc/handlers/projectRecipes.ts",
      "electron/ipc/handlers/recovery.ts",
      "electron/ipc/handlers/sentry.ts",
      "electron/ipc/handlers/shortcutHints.ts",
      "electron/ipc/handlers/systemShell.ts",
      "electron/ipc/handlers/systemSleep.ts",
      "electron/ipc/handlers/telemetry.ts",
      "electron/ipc/handlers/terminal/artifacts.ts",
      "electron/ipc/handlers/terminal/io.ts",
      "electron/ipc/handlers/terminal/lifecycle.ts",
      "electron/ipc/handlers/terminal/snapshots.ts",
      "electron/ipc/handlers/terminalConfig.ts",
      "electron/ipc/handlers/terminalLayout.ts",
      "electron/ipc/handlers/voiceInput.ts",
      "electron/ipc/handlers/webview.ts",
      "electron/ipc/handlers/worktree/branches.ts",
      "electron/ipc/handlers/worktree/lifecycle.ts",
      "electron/ipc/handlers/worktree/pull-requests.ts",
      "electron/ipc/handlers/worktreeConfig.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "ConditionalExpression[test.type='BinaryExpression'][test.operator='instanceof'][test.right.name='Error'][consequent.type='MemberExpression'][consequent.property.name='message']",
          message:
            "Use formatErrorMessage(err, 'operation-specific fallback') from @shared/utils/errorMessage instead of the inline `instanceof Error ? .message : ...` ternary.",
        },
        {
          selector:
            "UnaryExpression[operator='void'] > CallExpression > MemberExpression:has(MemberExpression[object.name='window'][property.name='electron'])",
          message:
            "Don't use `void window.electron.X()` for fire-and-forget IPC — wrap the promise in safeFireAndForget(promise, { context }) from @/utils/safeFireAndForget so rejections reach reportRendererGlobalError with call-site context.",
        },
        {
          selector:
            "CallExpression:matches([callee.name=/^(notify|addNotification)$/], [callee.property.name=/^(notify|addNotification)$/]) ObjectExpression > Property[key.name='message'] MemberExpression[property.name='message']:matches([object.name=/^(error|err|e)$/], [object.property.name=/^(error|err|e)$/])",
          message:
            "Don't pipe raw error.message into user-facing notifications. Use humanizeAppError(error) from @shared/utils/errorMessage to produce a friendly title and body, and stash the raw message in a 'Copy details' action. See #6050.",
        },
        {
          selector:
            "JSXAttribute[name.name='dangerouslySetInnerHTML'] > JSXExpressionContainer > ObjectExpression > Property[key.name='__html']:not(:has(CallExpression))",
          message:
            "Pass __html through createTrustedHTML(value) from @/lib/trustedTypesPolicy instead of a raw string. See #6392.",
        },
        {
          selector:
            "BinaryExpression[operator=/^(!==|===)$/]:matches([left.name='kind'], [left.property.name='kind'])[right.type='Literal'][right.value=/^(terminal|browser|dev-preview)$/]",
          message:
            "Don't compare panel.kind against string literals. Use registry helpers (panelKindHasPty, panelKindCanRestart) or sanctioned type guards (isPtyPanel, isBrowserPanel, isDevPreviewPanel) from @shared/types/panel. See #7672.",
        },
        {
          // Mirrored from the shared/**+electron/** warn block so the
          // legacy-allowlist override doesn't silently drop the guard for
          // the legacy handler files (flat-config last-write-wins). See #9123.
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.name='autoUpdater']:matches([left.property.name='channel'], [left.property.value='channel'])",
          message:
            "Don't assign to autoUpdater.channel directly — the setter unconditionally flips allowDowngrade=true, silently breaking the stable-channel rollback guard from #7573. Route channel changes through AutoUpdaterService (setFeedURL + explicit allowDowngrade). See #9123.",
        },
        {
          selector:
            "CallExpression[callee.name=/^(typedHandle|typedHandleWithContext|typedHandleValidated|typedHandleWithContextValidated)$/]",
          message:
            "Don't register IPC handlers with the legacy typedHandle* helpers from electron/ipc/utils. Use `defineIpcNamespace` from electron/ipc/define instead — it gives a single declarative surface for routing, validation, and error handling. See #8577.",
        },
        {
          // Mirrored from the global block (flat-config last-write-wins).
          // See #10047.
          selector:
            "CallExpression:matches([callee.type='MemberExpression'][callee.property.name=/^(setTag|setUser|setContext)$/], [callee.type='Identifier'][callee.name=/^(setTag|setUser|setContext)$/])",
          message:
            "Sentry scope setters (setTag/setUser/setContext) are centralized in TelemetryService.ts so every value entering event.tags/user/contexts stays within the scrubbing contract. Annotate a legitimate site with `// eslint-disable-next-line no-restricted-syntax -- sentry-scope-setter: ok` plus a rationale. See #10047.",
        },
      ],
    },
  },

  // SDK boundary guard: forge.js imports in shared/types/plugin.ts must
  // be classified in shared/types/plugin-sdk.ts. This is the single gate
  // that prevents forge-internal types from leaking into the public SDK
  // surface unclassified. Existing imports are grandfathered; new ones
  // must be accompanied by a corresponding re-export in plugin-sdk.ts.
  // See #9269, docs/plugins/architecture.md#sdk-surface.
  {
    files: ["shared/types/plugin.ts"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["./forge.js"],
              message:
                "Forge types imported here become part of the public SDK surface via PluginManifest/PluginHostApi. New forge imports must be classified and re-exported from shared/types/plugin-sdk.ts. See docs/plugins/architecture.md#sdk-surface and #9269.",
            },
          ],
        },
      ],
    },
  },

  // E2E structured test-skip annotations — enforce that every test.skip()
  // is preceded by test.info().annotations.push({ type, description })
  // with a valid type and, for quarantine, a YYYY-MM-DD date prefix.
  // See #9120.
  {
    files: ["e2e/**/*.spec.ts"],
    plugins: {
      "e2e-structured-skip": {
        rules: { "structured-test-skip-annotations": structuredTestSkipAnnotations },
      },
    },
    rules: {
      "e2e-structured-skip/structured-test-skip-annotations": "error",
    },
  },

  // Icon dimming — icons must use a solid theme token (text-text-muted), never
  // opacity-* utilities or grayscale, which composite differently on each theme
  // background. Scoped to icon elements only. See #10458.
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "icon-opacity-dimming": {
        rules: { "no-icon-opacity-dimming": iconOpacityDimming },
      },
    },
    rules: {
      "icon-opacity-dimming/no-icon-opacity-dimming": "error",
    },
  },

  // Prettier must be last to override conflicting rules
  prettier,

  // Global ignores
  {
    ignores: [
      "dist/**",
      "dist-electron/**",
      "dist-typecheck/**",
      // Built output of the workspace CLI packages (tsup). Bundled JS isn't
      // source and trips no-undef on Node globals when linted locally.
      "packages/*/dist/**",
      // Generated API-surface snapshots (raw tsup .d.ts output committed for
      // review by scripts/ci/check-api-surface.mjs) — not hand-authored source.
      "packages/*/api-report/**",
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
      ".claude/**",
      // Native N-API addons live under electron/native/. The CJS wrapper
      // and binding.gyp aren't part of the TypeScript build graph; they're
      // packaged build infrastructure (analogous to scripts/).
      "electron/native/**",
      // Sample plugin view assets are hand-authored, browser-ready ESM served
      // verbatim over `plugin://` (bare `react` resolved via the host import
      // map). They're test fixtures, not part of the TS build graph — like
      // packages/*/dist (#10512).
      "plugins/sample/*/view/**",
    ],
  }
);
