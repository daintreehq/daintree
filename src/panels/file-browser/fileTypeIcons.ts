import {
  Binary,
  Database,
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileKey,
  FileLock,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  type LucideIcon,
} from "lucide-react";

/**
 * File-type icons for the browser tree (#11596).
 *
 * Every row used to render the same generic `File`, so a folder of `.mp4`
 * clips looked exactly like a folder of source files. Classification is
 * filename-only — no MIME sniffing, no stat, no extra IPC — because the tree
 * already has the basename and nothing else is worth a round trip per row.
 *
 * Glyphs only: every icon paints the same neutral. The categories originally
 * carried `category-*` hues, and measuring the result on this repo is what
 * removed them — 80% of tracked files resolve to `source` alone, and 95% of
 * directories come out a single hue, so the code discriminated nothing in the
 * folders anyone actually browses and turned into a rainbow only in the root.
 * Three costs for that: the eight `category-*` hues already mean worktree
 * identity, agent state and action-palette category elsewhere in the app, so a
 * fourth meaning collided with all three; the tinted column competed with the
 * git status markers in the same rows, which are the load-bearing signal here;
 * and a saturated glyph beside a 70%-alpha filename put the metadata above the
 * content. Grey costs a channel that was carrying no information anyway.
 */

/** Category identity. Exposed so callers can group rows without matching on icon identity. */
export type FileTypeCategory =
  | "source"
  | "script"
  | "data"
  | "config"
  | "lock"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "document"
  | "spreadsheet"
  | "database"
  | "font"
  | "key"
  | "binary"
  | "unknown";

/**
 * The one neutral every tree entry icon paints in, file and folder alike.
 *
 * A complete Tailwind literal, never composed at runtime: the v4 scanner only
 * emits utilities it can find as whole strings in source.
 *
 * Secondary, and specifically NOT muted. Pre-#11596 these icons were
 * `text-daintree-text/30` (files) and `/40` (folders), which on a dark panel
 * is ~2.4:1 — under the 3:1 floor for a graphical object, and the "near
 * invisible" bug #11596 set out to fix. Muted looks like the tidier choice
 * because it sits a step below the `/70` filename it labels, but it is only
 * floored for light themes in `shared/theme/contrast.ts`: dark muted runs a
 * sanctioned sub-AA calibration that bottoms out at 2.22:1 on namib and
 * 2.50:1 on redwoods, which would reintroduce the original bug on two of the
 * seven dark themes. Secondary is guarded at >=3.0 on every surface in every
 * theme and measures >=4.96:1 across all fourteen, so it is the only tier
 * that holds. Anything quieter needs an all-theme, all-surface proof first.
 */
export const FILE_TREE_ICON_COLOR_CLASS = "text-text-secondary";

/**
 * Marker class on every tree entry icon, file and folder alike. Carries no
 * styling of its own — it exists so `@media (prefers-contrast: more)` in
 * `src/index.css` can lift the whole set to the solid text token. Exported so
 * the component and the stylesheet's contract test agree on one spelling.
 */
export const FILE_TREE_ICON_CLASS = "file-tree-entry-icon";

export interface FileTypeIcon {
  category: FileTypeCategory;
  Icon: LucideIcon;
}

/**
 * One glyph per category, and no two alike: with color gone the shape is the
 * only channel left, so a duplicate here would erase a category outright
 * rather than merely weakening it.
 */
const CATEGORIES: Record<FileTypeCategory, FileTypeIcon> = {
  source: { category: "source", Icon: FileCode },
  font: { category: "font", Icon: FileType },
  script: { category: "script", Icon: FileTerminal },
  audio: { category: "audio", Icon: FileMusic },
  data: { category: "data", Icon: FileBraces },
  spreadsheet: { category: "spreadsheet", Icon: FileSpreadsheet },
  config: { category: "config", Icon: FileCog },
  video: { category: "video", Icon: FilePlay },
  lock: { category: "lock", Icon: FileLock },
  document: { category: "document", Icon: FileText },
  image: { category: "image", Icon: FileImage },
  key: { category: "key", Icon: FileKey },
  archive: { category: "archive", Icon: FileArchive },
  binary: { category: "binary", Icon: Binary },
  database: { category: "database", Icon: Database },
  unknown: { category: "unknown", Icon: File },
};

/**
 * Extension → category. Keys are lowercase and carry no leading dot.
 *
 * `ts` is TypeScript, not MPEG transport stream: this is an IDE, and the cost
 * of the two readings is wildly asymmetric.
 */
const EXTENSION_CATEGORIES: Record<string, FileTypeCategory> = {
  // source
  js: "source",
  jsx: "source",
  ts: "source",
  tsx: "source",
  mjs: "source",
  cjs: "source",
  mts: "source",
  cts: "source",
  html: "source",
  htm: "source",
  css: "source",
  scss: "source",
  sass: "source",
  less: "source",
  styl: "source",
  xml: "source",
  xsl: "source",
  py: "source",
  pyw: "source",
  pyi: "source",
  rb: "source",
  go: "source",
  rs: "source",
  java: "source",
  kt: "source",
  kts: "source",
  swift: "source",
  m: "source",
  mm: "source",
  c: "source",
  cc: "source",
  cpp: "source",
  cxx: "source",
  h: "source",
  hh: "source",
  hpp: "source",
  hxx: "source",
  cs: "source",
  php: "source",
  ex: "source",
  exs: "source",
  erl: "source",
  hrl: "source",
  fs: "source",
  fsx: "source",
  vb: "source",
  lua: "source",
  pl: "source",
  pm: "source",
  r: "source",
  scala: "source",
  dart: "source",
  sol: "source",
  zig: "source",
  nim: "source",
  hs: "source",
  clj: "source",
  cljs: "source",
  cljc: "source",
  groovy: "source",
  vue: "source",
  svelte: "source",
  astro: "source",
  graphql: "source",
  gql: "source",
  proto: "source",
  ipynb: "source",

  // script
  sh: "script",
  bash: "script",
  zsh: "script",
  fish: "script",
  ksh: "script",
  ps1: "script",
  psm1: "script",
  bat: "script",
  cmd: "script",
  nu: "script",

  // data
  json: "data",
  jsonc: "data",
  json5: "data",
  jsonl: "data",
  ndjson: "data",
  geojson: "data",
  topojson: "data",
  map: "data",

  // config
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  cfg: "config",
  conf: "config",
  config: "config",
  properties: "config",
  plist: "config",
  tf: "config",
  tfvars: "config",
  hcl: "config",

  // lock
  lock: "lock",
  lockb: "lock",

  // image
  png: "image",
  jpg: "image",
  jpeg: "image",
  jpe: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  svg: "image",
  ico: "image",
  icns: "image",
  bmp: "image",
  tif: "image",
  tiff: "image",
  heic: "image",
  heif: "image",
  psd: "image",
  ai: "image",
  sketch: "image",
  fig: "image",

  // video
  mp4: "video",
  m4v: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  webm: "video",
  mpeg: "video",
  mpg: "video",
  mpe: "video",
  wmv: "video",
  flv: "video",
  ogv: "video",
  "3gp": "video",
  "3g2": "video",

  // audio
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  aac: "audio",
  m4a: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  wma: "audio",
  aiff: "audio",
  aif: "audio",
  midi: "audio",
  mid: "audio",

  // archive — package artifacts live here too: a .jar, .whl or .deb is a
  // container, and giving them their own glyph would split one idea in two.
  zip: "archive",
  "7z": "archive",
  rar: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  tbz: "archive",
  tbz2: "archive",
  xz: "archive",
  txz: "archive",
  zst: "archive",
  tzst: "archive",
  lz: "archive",
  lz4: "archive",
  cab: "archive",
  iso: "archive",
  dmg: "archive",
  jar: "archive",
  war: "archive",
  ear: "archive",
  apk: "archive",
  ipa: "archive",
  deb: "archive",
  rpm: "archive",
  pkg: "archive",
  msi: "archive",
  nupkg: "archive",
  gem: "archive",
  whl: "archive",
  egg: "archive",
  crate: "archive",

  // document
  txt: "document",
  md: "document",
  mdx: "document",
  markdown: "document",
  rst: "document",
  adoc: "document",
  asciidoc: "document",
  org: "document",
  rtf: "document",
  pdf: "document",
  tex: "document",
  bib: "document",
  log: "document",
  doc: "document",
  docx: "document",
  odt: "document",
  pages: "document",
  ppt: "document",
  pptx: "document",
  odp: "document",

  // spreadsheet
  csv: "spreadsheet",
  tsv: "spreadsheet",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  xlsm: "spreadsheet",
  ods: "spreadsheet",
  ots: "spreadsheet",
  numbers: "spreadsheet",

  // database
  sql: "database",
  db: "database",
  db3: "database",
  sqlite: "database",
  sqlite3: "database",
  duckdb: "database",
  parquet: "database",
  avro: "database",
  orc: "database",

  // font
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  eot: "font",

  // key / certificate
  pem: "key",
  crt: "key",
  cer: "key",
  der: "key",
  p12: "key",
  pfx: "key",
  key: "key",
  pub: "key",
  jks: "key",
  keystore: "key",
  gpg: "key",
  asc: "key",

  // binary
  bin: "binary",
  exe: "binary",
  dll: "binary",
  so: "binary",
  dylib: "binary",
  o: "binary",
  obj: "binary",
  a: "binary",
  lib: "binary",
  class: "binary",
  pyc: "binary",
  pyo: "binary",
  wasm: "binary",
};

/**
 * Exact basenames, lowercase. Checked before extensions so a manifest wins
 * over its own container format — `package-lock.json` is a lockfile first and
 * JSON second, `Cargo.toml` is a manifest first and TOML second.
 */
const BASENAME_CATEGORIES: Record<string, FileTypeCategory> = {
  // lockfiles
  "package-lock.json": "lock",
  "npm-shrinkwrap.json": "lock",
  "packages.lock.json": "lock",
  "pnpm-lock.yaml": "lock",
  "yarn.lock": "lock",
  "bun.lock": "lock",
  "bun.lockb": "lock",
  "deno.lock": "lock",
  "cargo.lock": "lock",
  "gemfile.lock": "lock",
  "composer.lock": "lock",
  "poetry.lock": "lock",
  "pipfile.lock": "lock",
  "uv.lock": "lock",
  "mix.lock": "lock",
  "go.sum": "lock",
  "flake.lock": "lock",
  "pubspec.lock": "lock",
  "podfile.lock": "lock",
  "package.resolved": "lock",
  "gradle.lockfile": "lock",
  // Ends in `.hcl`, so without an exact entry it would read as Terraform config.
  ".terraform.lock.hcl": "lock",

  // manifests and tool config — extensionless or extension-misleading
  dockerfile: "config",
  containerfile: "config",
  makefile: "config",
  gnumakefile: "config",
  justfile: "config",
  procfile: "config",
  rakefile: "config",
  gemfile: "config",
  pipfile: "config",
  brewfile: "config",
  vagrantfile: "config",
  "cmakelists.txt": "config",
  "meson.build": "config",
  "package.json": "config",
  "deno.json": "config",
  "deno.jsonc": "config",
  "composer.json": "config",
  "bower.json": "config",
  "go.mod": "config",
  "go.work": "config",
  "build.gradle": "config",
  "build.gradle.kts": "config",
  "settings.gradle": "config",
  "settings.gradle.kts": "config",
  // The wrapper launchers are executables, not Gradle configuration.
  gradlew: "script",
  codeowners: "config",
  ".gitignore": "config",
  ".gitattributes": "config",
  ".gitmodules": "config",
  ".gitkeep": "config",
  ".dockerignore": "config",
  ".npmignore": "config",
  ".prettierignore": "config",
  ".eslintignore": "config",
  ".editorconfig": "config",
  ".nvmrc": "config",
  ".node-version": "config",
  ".python-version": "config",
  ".ruby-version": "config",
  ".tool-versions": "config",

  // documents — extensionless by convention
  readme: "document",
  license: "document",
  licence: "document",
  changelog: "document",
  contributing: "document",
  notice: "document",
  authors: "document",
  contributors: "document",
  copying: "document",
  install: "document",
  todo: "document",
};

/**
 * Basename patterns, tried after exact matches and before extensions. Ordered
 * most-specific first: `tsconfig.build.json` must not be read as plain JSON,
 * and `vite.config.ts` must not be read as TypeScript.
 */
const BASENAME_PATTERNS: ReadonlyArray<readonly [RegExp, FileTypeCategory]> = [
  // .env, .env.local, .env.production.local
  [/^\.env(\..+)?$/, "config"],
  // vite.config.ts, jest.config.mjs, tailwind.config.js. The trailing format is
  // enumerated rather than left open: `.config.` is a common enough infix that
  // an open suffix would swallow `photo.config.png` and `payload.config.exe`,
  // whose own extensions are the stronger signal.
  [/\.config\.([cm]?[jt]s|jsonc?|json5|ya?ml|toml|ini)$/, "config"],
  // tsconfig.json, tsconfig.build.json, jsconfig.json
  [/^[jt]sconfig(\..+)?\.json$/, "config"],
  // .prettierrc, .eslintrc.json, .babelrc.cjs, .npmrc, .yarnrc.yml
  [/^\.[a-z0-9_-]+rc(\.[a-z0-9]+)?$/, "config"],
  // Dockerfile.dev, Dockerfile.prod
  [/^(docker|container)file\..+$/, "config"],
  // docker-compose.yml, compose.override.yaml
  [/^(docker-)?compose(\..+)?\.ya?ml$/, "config"],
];

/** Basename of a POSIX or Windows path, lowercased. Mirrors `getLanguageForFile`'s split. */
function basenameOf(filePath: string): string {
  const posix = filePath.split("/").pop() ?? filePath;
  return (posix.split("\\").pop() ?? posix).toLowerCase();
}

/**
 * Icon and category for one tree row, keyed off its name alone.
 *
 * Resolution runs exact basename → pattern → extension → unknown, so the most
 * specific reading of a name always wins. Every step is an O(1) lookup or a
 * short fixed pattern list against module-scope constants; Virtuoso only ever
 * asks about visible rows, so there is nothing here worth memoizing.
 */
export function getFileTypeIcon(filePath: string): FileTypeIcon {
  const basename = basenameOf(filePath);

  // `Object.hasOwn` rather than a bare lookup: these tables are plain objects,
  // so a file genuinely named `constructor` or `__proto__` would otherwise read
  // an inherited member, index CATEGORIES with a function, and hand back
  // `undefined` from a signature that promises it never does.
  if (Object.hasOwn(BASENAME_CATEGORIES, basename)) {
    return CATEGORIES[BASENAME_CATEGORIES[basename]!];
  }

  for (const [pattern, category] of BASENAME_PATTERNS) {
    if (pattern.test(basename)) return CATEGORIES[category];
  }

  // `dotIndex > 0` keeps a leading dot from reading as an extension:
  // `.gitignore` is a whole name, not an entry with a `gitignore` suffix.
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex > 0) {
    const extension = basename.slice(dotIndex + 1);
    if (Object.hasOwn(EXTENSION_CATEGORIES, extension)) {
      return CATEGORIES[EXTENSION_CATEGORIES[extension]!];
    }
  }

  return CATEGORIES.unknown;
}
