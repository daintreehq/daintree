import {
  isArbitraryTextSize,
  isFocusTreatment,
  isRawArbitraryShadow,
  isRawRadius,
  isTextColourSlashAlpha,
  LEGACY_DAINTREE,
  legacyAlias,
  splitModifier,
  splitToken,
  STOCK_COLOUR,
  STOCK_SHADOW,
} from "../classTokens.js";
import { hasProp, propString } from "../extract.js";
import { matchClose } from "../source.js";
import type { ClassToken, LintFile, LintRule, RuleHit } from "../types.js";

/** A rule over every class token, reporting each one `test` names a message for. */
function classRule(
  base: Omit<LintRule, "check" | "appliesTo">,
  test: (token: string, split: ReturnType<typeof splitToken>) => string | null
): LintRule {
  return {
    ...base,
    appliesTo: "any",
    check(file) {
      const hits: RuleHit[] = [];
      for (const context of file.classContexts) {
        for (const { token, offset } of context) {
          const message = test(token, splitToken(token));
          if (message !== null) hits.push({ offset, message });
        }
      }
      return hits;
    },
  };
}

const stockColour = classRule(
  {
    id: "stock-palette-colour",
    severity: "error",
    message: "stock Tailwind colour",
    hint: "use a semantic token (bg-surface-panel, text-text-secondary, text-status-danger, border-border-default); themes are runtime tokens",
  },
  (token, { base }) =>
    STOCK_COLOUR.test(splitModifier(base).value)
      ? `"${token}" is a stock Tailwind colour, which compiles to nothing in a plugin`
      : null
);

const darkVariant = classRule(
  {
    id: "dark-variant",
    severity: "warn",
    message: "`dark:` follows the OS colour scheme, not the Daintree theme",
    hint: "drop the dark: variant — semantic tokens already change with the theme",
  },
  (token, { variants }) =>
    variants.includes("dark")
      ? `"${token}" uses dark:, which follows the OS colour scheme rather than the Daintree theme`
      : null
);

const legacyUtility = classRule(
  {
    id: "legacy-daintree-utility",
    severity: "warn",
    message: "legacy daintree-* colour alias",
    hint: "use the semantic token the alias points at",
  },
  (token, { base }) => {
    const legacy = legacyAlias(base);
    if (!legacy) return null;
    const replacement = LEGACY_DAINTREE.get(legacy.alias);
    return replacement
      ? `"${token}" is a legacy alias; use ${legacy.prefix}-${replacement}`
      : `"${token}" is a legacy daintree-* alias with no semantic equivalent here`;
  }
);

const rawShadow = classRule(
  {
    id: "raw-shadow",
    severity: "warn",
    message: "stock or hardcoded shadow",
    hint: "use shadow-[var(--theme-shadow-ambient)], shadow-[var(--theme-shadow-floating)] or shadow-[var(--theme-shadow-dialog)]",
  },
  (token, { base }) =>
    STOCK_SHADOW.test(base) || isRawArbitraryShadow(base)
      ? `"${token}" draws a fixed-colour shadow that ignores the theme`
      : null
);

const arbitraryTextSize = classRule(
  {
    id: "arbitrary-text-size",
    severity: "warn",
    message: "arbitrary font size",
    hint: "use a step of the type scale: text-2xs, text-xs, text-sm, text-base, text-lg",
  },
  (token, { base }) => (isArbitraryTextSize(base) ? `"${token}" is off the type scale` : null)
);

const textSlashAlpha = classRule(
  {
    id: "text-colour-slash-alpha",
    severity: "warn",
    message: "text colour with slash alpha",
    hint: "use a solid token one step down instead (text-text-secondary, text-text-muted)",
  },
  (token, { base }) =>
    isTextColourSlashAlpha(base)
      ? `"${token}" fades the glyphs against whatever is behind them, losing contrast`
      : null
);

const rawRadius = classRule(
  {
    id: "raw-radius",
    severity: "warn",
    message: "radius off the theme's scale",
    hint: "name a step (rounded-sm, rounded-md, rounded-lg) or read a token (rounded-[var(--radius-md)])",
  },
  (token, { base }) =>
    isRawRadius(base)
      ? base.includes("[")
        ? `"${token}" hardcodes a radius the theme's radius scale cannot move`
        : `"${token}" renders the theme's rounded-lg, not Tailwind's 0.25rem; name the step you mean`
      : null
);

const spinner = classRule(
  {
    id: "hand-rolled-spinner",
    severity: "warn",
    message: "hand-applied animate-spin",
    hint: "prefer `Spinner` from @daintreehq/plugin-ui",
  },
  (_token, { base }) =>
    base === "animate-spin"
      ? "animate-spin applied by hand; the kit's spinner respects reduced motion"
      : null
);

const badge = classRule(
  {
    id: "hand-rolled-badge",
    severity: "warn",
    message: "hand-tinted status pill",
    hint: "prefer `Badge` from @daintreehq/plugin-ui",
  },
  (token, { base }) =>
    /^bg-status-(?:error|danger|warning|success|info)\/10$/.test(base)
      ? `"${token}" hand-tints a status pill`
      : null
);

function outlineHits(context: ClassToken[]): RuleHit[] {
  const hits: RuleHit[] = [];
  const split = context.map((entry) => ({ ...entry, ...splitToken(entry.token) }));
  const covered = split.some(({ variants, base }) => isFocusTreatment(variants, base));
  for (const { token, offset, variants, base } of split) {
    if (variants.length > 0) continue;
    if (base === "outline-none") {
      hits.push({
        offset,
        message: `"${token}" removes the outline even in forced-colours mode; use outline-hidden with a focus-visible: ring`,
      });
    } else if ((base === "outline-hidden" || base === "outline-0") && !covered) {
      hits.push({
        offset,
        message: `"${token}" hides the focus outline and nothing paints a replacement`,
      });
    }
  }
  return hits;
}

const outlineSuppression: LintRule = {
  id: "unpaired-outline-suppression",
  severity: "warn",
  appliesTo: "any",
  message: "focus outline suppressed without a replacement",
  hint: "pair it with a visible focus treatment, e.g. focus-visible:ring-2 focus-visible:ring-border-strong",
  check(file) {
    return file.classContexts.flatMap(outlineHits);
  },
};

const applyDirective: LintRule = {
  id: "apply-directive",
  severity: "warn",
  appliesTo: "any",
  target: "style",
  message: "@apply needs a Tailwind build step plugin styles never get",
  hint: "put the utilities on the element's className instead",
  check(file) {
    return [...file.code.matchAll(/@apply\b/g)].map((m) => ({ offset: m.index }));
  },
};

function elementRule(
  base: Omit<LintRule, "check" | "appliesTo">,
  test: (file: LintFile, element: LintFile["elements"][number]) => string | null
): LintRule {
  return {
    ...base,
    appliesTo: "view",
    check(file) {
      const hits: RuleHit[] = [];
      for (const element of file.elements) {
        const message = test(file, element);
        if (message !== null) hits.push({ offset: element.offset, message });
      }
      return hits;
    },
  };
}

const rawButton = elementRule(
  {
    id: "raw-button",
    severity: "warn",
    message: "raw <button>",
    hint: "prefer `Button` from @daintreehq/plugin-ui — it carries the host's focus ring, sizes and variants",
  },
  (_file, element) =>
    element.intrinsic && element.tag === "button" ? "raw <button> restyles a kit primitive" : null
);

/** The `type`s the kit `Input` renders as-is; it coerces any other to `text`. */
const KIT_INPUT_TYPES = new Set(["text", "search", "email", "url", "password", "number", "tel"]);

const KIT_FOR_INPUT: Record<string, string> = {
  // A token or key: masked, with reveal and a saved state, copy blocked.
  password: "SecretInput",
  checkbox: "Checkbox",
  radio: "RadioGroup",
  range: "Slider",
  date: "DatePicker",
  time: "TimePicker",
  "datetime-local": "DateTimePicker",
  color: "ColorPicker",
  button: "Button",
  submit: "Button",
  reset: "Button",
};

const rawFormControl = elementRule(
  {
    id: "raw-form-control",
    severity: "warn",
    message: "raw form control",
    hint: "prefer the matching component from @daintreehq/plugin-ui",
  },
  (file, element) => {
    if (!element.intrinsic) return null;
    if (element.tag === "textarea")
      return "raw <textarea>; prefer `Textarea` from @daintreehq/plugin-ui";
    if (element.tag === "select") {
      return hasProp(file, element, "multiple")
        ? "raw <select multiple>; prefer `MultiSelect` from @daintreehq/plugin-ui"
        : "raw <select>; prefer `Select` from @daintreehq/plugin-ui";
    }
    if (element.tag !== "input") return null;
    const literal = propString(file, element, "type");
    // A computed type could be anything; only a literal one is worth a suggestion.
    if (literal === null && hasProp(file, element, "type")) return null;
    const type = (literal ?? "text").toLowerCase();
    const kit = KIT_FOR_INPUT[type] ?? (KIT_INPUT_TYPES.has(type) ? "Input" : null);
    // hidden, month, week and the rest have no kit control: the native
    // element, styled with theme tokens, is the right call. A file input is
    // often the hidden half of a plugin's own "Import…" button, so it is left
    // alone rather than pointed at `FileDropzone`.
    if (kit === null) return null;
    return `raw <input type="${type}">; prefer \`${kit}\` from @daintreehq/plugin-ui`;
  }
);

const nativeTitle = elementRule(
  {
    id: "native-title-tooltip",
    severity: "warn",
    message: "native title= tooltip",
    hint: "prefer `Tooltip` from @daintreehq/plugin-ui, or `IconButton`'s `tooltip` prop — the OS tooltip ignores the theme and the keyboard",
  },
  // Intrinsic elements only: `title` is part of the kit components' public DOM props.
  (file, element) =>
    element.intrinsic && hasProp(file, element, "title")
      ? `title= on <${element.tag}> draws an OS tooltip`
      : null
);

const inlineSvgIcon = elementRule(
  {
    id: "inline-svg-icon",
    severity: "warn",
    message: "inline 24×24 SVG icon",
    hint: "prefer `Icon` from @daintreehq/plugin-ui, which draws the host's own icon set",
  },
  (file, element) =>
    element.intrinsic &&
    element.tag === "svg" &&
    propString(file, element, "viewBox")?.trim() === "0 0 24 24"
      ? "inline 24×24 <svg> copies an icon the kit already draws"
      : null
);

const lucideImport: LintRule = {
  id: "lucide-react-import",
  severity: "warn",
  appliesTo: "view",
  message: "lucide-react is bundled into the view",
  hint: "prefer `Icon` from @daintreehq/plugin-ui, served by the host at no bundle cost",
  check(file) {
    const match = /(?:from\s*|import\s*\(\s*|require\(\s*)["']lucide-react(?:\/[^"']*)?["']/.exec(
      file.code
    );
    return match ? [{ offset: match.index }] : [];
  },
};

// The drag-and-drop libraries a view reaches for to reorder a list or build a
// board, all of which the kit now covers.
const DND_LIBRARY_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*|\bimport\s+)["'](?:@dnd-kit\/[\w-]+|react-beautiful-dnd|@hello-pangea\/dnd|react-dnd(?:-[\w-]+)?|sortablejs|react-sortablejs|@atlaskit\/pragmatic-drag-and-drop[\w-]*)(?:\/[^"']*)?["']/;

const dndLibraryImport: LintRule = {
  id: "dnd-library-import",
  severity: "warn",
  appliesTo: "view",
  message: "a drag-and-drop library is bundled into the view",
  hint: "prefer `SortableList`, `Kanban` or `DragDropProvider` from @daintreehq/plugin-ui: keyboard dragging, announcements and the app's lift, and drags that stay inside the view",
  check(file) {
    const match = DND_LIBRARY_IMPORT.exec(file.code);
    return match ? [{ offset: match.index }] : [];
  },
};

/** `@container`, `@container/name` — the element declares itself a query container. */
const CONTAINER_DECLARATION = /^@container(?:\/([\w-]+))?$/;
/** `@md`, `@max-lg`, `@min-[400px]`, `@sm/name` — a container-query variant, with its container name. */
const CONTAINER_VARIANT =
  /^@(?!container(?:\/|$))(?:min-|max-)?(?:\[[^\]]+\]|[\w.-]+)(?:\/([\w-]+))?$/;

function selfContainerHits(context: ClassToken[]): RuleHit[] {
  const declared = new Set<string>();
  for (const { token } of context) {
    const { variants, base } = splitToken(token);
    if (variants.length > 0) continue;
    const match = CONTAINER_DECLARATION.exec(base);
    if (match) declared.add(match[1] ?? "");
  }
  if (declared.size === 0) return [];
  const hits: RuleHit[] = [];
  for (const { token, offset } of context) {
    const variant = splitToken(token).variants.find((v) => CONTAINER_VARIANT.test(v));
    if (!variant) continue;
    const name = CONTAINER_VARIANT.exec(variant)?.[1];
    // An unnamed variant queries the nearest ancestor container, never the
    // element itself; a named one only misses when it names this element.
    if (name !== undefined && !declared.has(name)) continue;
    hits.push({
      offset,
      message: `"${token}" sits on the element that declares the container, and a container query never matches its own container`,
    });
  }
  return hits;
}

const selfContainerQuery: LintRule = {
  id: "self-container-query",
  severity: "warn",
  appliesTo: "any",
  message: "container-query variant on the container itself",
  hint: "put @container on a wrapping element and keep the @md:/@lg: variants on its children — the container must be an ancestor",
  // Reads one class string at a time, so a container and its variant split
  // across separate cn() arguments are not paired.
  check(file) {
    // Per string literal, not per class context: a `*Styles` object holds
    // one element's classes per property, and pairing `root: "@container"`
    // with `child: "@md:…"` would flag the idiom this rule recommends. The
    // lab's case — both on one class string — is the one worth catching.
    return file.classContexts.flatMap((context) => {
      const bySegment = new Map<number, ClassToken[]>();
      for (const token of context) {
        const segment = file.strings.findIndex(
          (s) => token.offset >= s.start && token.offset < s.end
        );
        const group = bySegment.get(segment);
        if (group) group.push(token);
        else bySegment.set(segment, [token]);
      }
      return [...bySegment.values()].flatMap(selfContainerHits);
    });
  },
};

const VIEWPORT_VARIANT = /^(?:max-)?(?:sm|md|lg|xl|2xl)$|^(?:min|max)-\[/;

const viewportBreakpoint = classRule(
  {
    id: "viewport-breakpoint",
    severity: "warn",
    message: "viewport breakpoint in a panel",
    hint: "a panel is one pane of the window: use a container query (@container on a wrapper, @md: on its children), AutoGrid, or useBreakpoint from @daintreehq/plugin-ui",
  },
  (token, { variants }) =>
    variants.some((variant) => VIEWPORT_VARIANT.test(variant))
      ? `"${token}" answers to the window's width, not the pane's`
      : null
);

const SLIDE_OFF = /^-?translate-[xy]-full$/;

const handRolledDrawer = classRule(
  {
    id: "hand-rolled-drawer",
    severity: "warn",
    message: "hand-built slide-in panel",
    hint: "prefer `Drawer` (with `DrawerToggle`) from @daintreehq/plugin-ui: it slides in within the pane, over or beside the content, holds focus when modal and closes on Escape",
  },
  (token, { base }) =>
    SLIDE_OFF.test(base) ? `"${token}" slides a panel off the pane's edge by hand` : null
);

// The forge state inks, which only ever ride a state glyph: a view reaching for
// them is drawing an issue or pull request row's mark itself.
const FORGE_STATE_INK =
  /^(?:text|bg|border(?:-[xytrblse])?|fill|stroke|ring|outline|decoration)-pr-(?:open|draft|merged|closed)$/;

const handRolledForgeState = classRule(
  {
    id: "hand-rolled-forge-state",
    severity: "warn",
    message: "issue or pull request state painted by hand",
    hint: "prefer `ForgeStateBadge`, `IssueRow` or `PullRequestRow` from @daintreehq/plugin-ui: the host's state glyphs and rows, the same for every forge",
  },
  (token, { base }) =>
    FORGE_STATE_INK.test(splitModifier(base).value)
      ? `"${token}" paints a forge state by hand`
      : null
);

const NATIVE_DIALOG =
  /(?:\b(?:window|globalThis|self)\s*\.\s*|(?<![\w$.]))(confirm|alert|prompt)\s*\(/g;

/** A local binding named `name` — a hook result, an import, a parameter — which a bare call means instead. */
function bindsName(masked: string, name: string): boolean {
  const declared = new RegExp(`\\b(?:function\\s*\\*?|const|let|var|class|as)\\s+${name}\\b`);
  // A destructured or imported name, or a parameter: `{ confirm }`, `(confirm) =>`.
  const listed = new RegExp(`[{,(]\\s*${name}\\s*(?=[,})=])`);
  return declared.test(masked) || listed.test(masked);
}

const DIALOG_KIT: Record<string, string> = {
  confirm: "ConfirmDialog",
  alert: "Dialog, or a Callout inline",
  prompt: "Dialog with an Input",
};

const nativeDialogInView: LintRule = {
  id: "native-dialog-in-view",
  severity: "warn",
  appliesTo: "view",
  message: "native browser dialog in a view",
  hint: "use ConfirmDialog or Dialog from @daintreehq/plugin-ui — a native dialog ignores the theme, blocks the whole window and takes focus from every other panel",
  check(file) {
    const hits: RuleHit[] = [];
    for (const m of file.masked.matchAll(NATIVE_DIALOG)) {
      const name = m[1]!;
      const qualified = !m[0].startsWith(name);
      if (!qualified) {
        // `confirm(…) { … }` is a method being declared, not called.
        const close = matchClose(file.masked, m.index + m[0].length - 1);
        if (close > 0 && /^\s*\{/.test(file.masked.slice(close + 1, close + 40))) continue;
        // File-wide, not scope-aware: a local `confirm` anywhere in the file
        // suppresses bare calls everywhere in it, trading a miss for no noise.
        if (bindsName(file.masked, name)) continue;
      }
      hits.push({
        offset: m.index,
        message: `${qualified ? m[0].replace(/\s+/g, "").replace(/\($/, "") : name}() opens a native dialog; use ${DIALOG_KIT[name]} from @daintreehq/plugin-ui`,
      });
    }
    return hits;
  },
};

/**
 * `localStorage.getItem(…)`, `window.sessionStorage[…]`: the browser's storage,
 * bare or on the global object — never another object's property of that name.
 */
const WEB_STORAGE =
  /(?:\b(?:window|globalThis|self)\s*\.\s*|(?<![\w$.]))(localStorage|sessionStorage)\b(?!\s*:)/g;

/** Where `import … from` clauses sit, so a name one imports is not read as a use. */
function importRanges(masked: string): Array<[number, number]> {
  return [...masked.matchAll(/\bimport\b[^;]*?\bfrom\b/g)].map((m) => [
    m.index,
    m.index + m[0].length,
  ]);
}

const viewWebStorage: LintRule = {
  id: "view-web-storage",
  severity: "warn",
  appliesTo: "view",
  message: "browser storage in a view",
  hint: "use usePersistentViewState from @daintreehq/plugin-ui for a tab, split size or filter (it rides the panel's own saved state), or host.storage in the worker for anything that outlives the panel — localStorage is one bucket shared by every plugin and the app",
  check(file) {
    const hits: RuleHit[] = [];
    const imports = importRanges(file.masked);
    for (const m of file.masked.matchAll(WEB_STORAGE)) {
      const name = m[1]!;
      if (imports.some(([start, end]) => m.index >= start && m.index < end)) continue;
      const qualified = !m[0].startsWith(name);
      // A local binding of that name shadows only the bare reference.
      if (!qualified && bindsName(file.masked, name)) continue;
      hits.push({ offset: m.index, message: `${name} in a view; use usePersistentViewState` });
    }
    return hits;
  },
};

/** `document.addEventListener("keydown", …)` and the window's — a hand-rolled shortcut listener. */
const GLOBAL_KEY_LISTENER =
  /(?<![\w$.])(?:window|document|globalThis)\s*\.\s*addEventListener\s*\(\s*["'`](keydown|keyup)["'`]/g;

const globalKeyListener: LintRule = {
  id: "global-key-listener",
  severity: "warn",
  appliesTo: "view",
  message: "shortcut listener on the whole document",
  hint: "use useHotkeys from @daintreehq/plugin-ui: it listens only while focus is in your view, leaves text fields alone and never takes a key Daintree is bound to",
  check(file) {
    const hits: RuleHit[] = [];
    // The event name is a string literal, which masking blanks, so read the
    // original code at the masked match's offsets.
    for (const m of file.code.matchAll(GLOBAL_KEY_LISTENER)) {
      if (!/addEventListener/.test(file.masked.slice(m.index, m.index + m[0].length))) continue;
      hits.push({ offset: m.index, message: `a global ${m[1]} listener; use useHotkeys` });
    }
    return hits;
  },
};

const rawPortal: LintRule = {
  id: "raw-portal",
  severity: "warn",
  appliesTo: "view",
  message: "createPortal in a view",
  hint: "prefer `Portal` from @daintreehq/plugin-ui — it marks the container as your style root, which a bare createPortal leaves unstyled",
  check(file) {
    // Only a file that imports react-dom can be calling its createPortal, which
    // keeps an unrelated method of the same name quiet; an aliased import
    // (`createPortal as portal`) is followed to its local name.
    if (
      !/from\s*["']react-dom(?:\/client)?["']|require\(\s*["']react-dom["']\s*\)/.test(file.code)
    ) {
      return [];
    }
    const names = ["createPortal"];
    for (const m of file.code.matchAll(/\bcreatePortal\s+as\s+([A-Za-z_$][\w$]*)/g)) {
      names.push(m[1]!);
    }
    const hits: RuleHit[] = [];
    const call = new RegExp(`(?<![\\w$])(?:${names.join("|")})\\s*\\(`, "g");
    for (const m of file.masked.matchAll(call)) {
      // `createPortal(…) { … }` is a method being declared, not called.
      const close = matchClose(file.masked, m.index + m[0].length - 1);
      if (close > 0 && /^\s*\{/.test(file.masked.slice(close + 1, close + 40))) continue;
      hits.push({ offset: m.index, message: "createPortal renders outside the view's style root" });
    }
    return hits;
  },
};

// The editor and diff libraries a view bundles to edit code or show a change,
// which the kit's CodeEditor and DiffView now serve themed from the host.
const EDITOR_LIBRARY_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*|\bimport\s+)["'](?:@codemirror\/[\w-]+|codemirror|@uiw\/(?:react-)?codemirror[\w-]*|react-diff-view|diff2html|react-diff-viewer(?:-continued)?)(?:\/[^"']*)?["']/;

const editorLibraryImport: LintRule = {
  id: "editor-library-import",
  severity: "warn",
  appliesTo: "view",
  message: "a code editor or diff library is bundled into the view",
  hint: "prefer `CodeEditor` or `DiffView` from @daintreehq/plugin-ui: Daintree's own editor and diff viewer, themed with the app and loaded by the host",
  check(file) {
    const match = EDITOR_LIBRARY_IMPORT.exec(file.code);
    return match ? [{ offset: match.index }] : [];
  },
};

// The table, tree and JSON-viewer libraries a view reaches for to show records
// or an API response, which the kit's DataTable, TreeView and ObjectInspector
// now cover in the host's own rows.
const DATA_VIEW_LIBRARY_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*|\bimport\s+)["'](?:@tanstack\/react-table|react-table|ag-grid-[\w-]+|react-data-grid|@mui\/x-data-grid[\w-]*|react-arborist|rc-tree|react-complex-tree|react-json-view|@microlink\/react-json-view|@uiw\/react-json-view|react-json-tree|react-inspector)(?:\/[^"']*)?["']/;

const dataViewLibraryImport: LintRule = {
  id: "data-view-library-import",
  severity: "warn",
  appliesTo: "view",
  message: "a data grid, tree or JSON viewer library is bundled into the view",
  hint: "prefer `DataTable`, `TreeView` or `ObjectInspector` from @daintreehq/plugin-ui: selection, groups, editing, lazy trees and value inspection in the host's own rows, served at no bundle cost",
  check(file) {
    const pattern = new RegExp(DATA_VIEW_LIBRARY_IMPORT.source, "g");
    for (const match of file.code.matchAll(pattern)) {
      // `import type …` and `export type …` bundle nothing.
      const start = file.code.lastIndexOf("\n", match.index) + 1;
      if (/^\s*(?:import|export)\s+type\b/.test(file.code.slice(start, match.index))) continue;
      return [{ offset: match.index }];
    }
    return [];
  },
};

export const CONSISTENCY_RULES: LintRule[] = [
  stockColour,
  darkVariant,
  legacyUtility,
  rawShadow,
  arbitraryTextSize,
  textSlashAlpha,
  rawRadius,
  outlineSuppression,
  spinner,
  badge,
  applyDirective,
  rawButton,
  rawFormControl,
  nativeTitle,
  inlineSvgIcon,
  lucideImport,
  dndLibraryImport,
  selfContainerQuery,
  nativeDialogInView,
  viewWebStorage,
  globalKeyListener,
  rawPortal,
  viewportBreakpoint,
  editorLibraryImport,
  dataViewLibraryImport,
  handRolledDrawer,
  handRolledForgeState,
];
