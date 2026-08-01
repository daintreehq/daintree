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
import type { WORKTREE_COLOR_PALETTE } from "@shared/theme/worktreeColors";

/**
 * File-type icons for the browser tree (#11596).
 *
 * Every row used to render the same generic `File`, so a folder of `.mp4`
 * clips looked exactly like a folder of source files. Classification is
 * filename-only — no MIME sniffing, no stat, no extra IPC — because the tree
 * already has the basename and nothing else is worth a round trip per row.
 *
 * Colors come from the existing `category-*` theme tokens, never the accent:
 * accent restraint allows one load-bearing accent signal per focus region, and
 * a tree tinting dozens of rows at once is exactly what that forbids. The hues
 * are limited to the eight-token CVD-safe subset `WORKTREE_COLOR_PALETTE`
 * already proven distinguishable under all three dichromacies across every
 * built-in theme, so this map inherits that proof instead of restating it.
 *
 * At `h-3.5` shape carries the signal and color only reinforces it — which is
 * why hues repeat across categories whose glyphs look nothing alike (a gear
 * and a play triangle both sit on violet), and why dropping to monochrome
 * under `prefers-contrast: more` costs nothing but the reinforcement.
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

type CategoryColor = `text-${(typeof WORKTREE_COLOR_PALETTE)[number]}`;

/** The neutral every unrecognized file falls back to — deliberately outside the categorical palette. */
export const UNKNOWN_FILE_COLOR_CLASS = "text-text-secondary";

/**
 * Marker class on every tree entry icon, file and folder alike. Carries no
 * styling of its own — it exists so `@media (prefers-contrast: more)` in
 * `src/index.css` can repaint the whole set monochrome. Exported so the
 * component and the stylesheet's contract test agree on one spelling.
 */
export const FILE_TREE_ICON_CLASS = "file-tree-entry-icon";

export interface FileTypeIcon {
  category: FileTypeCategory;
  Icon: LucideIcon;
  /**
   * A complete Tailwind literal, never composed at runtime: the v4 scanner
   * only emits utilities it can find as whole strings in source.
   */
  colorClass: CategoryColor | typeof UNKNOWN_FILE_COLOR_CLASS;
}

/**
 * Fifteen categories over eight hues, so seven pairs share a color. Pairing is
 * by *inner mark*, not by meaning: almost every glyph here is a page outline
 * with a symbol inside it, so the silhouette can't separate them and the
 * symbol has to. Each pair below is a padlock against text lines, a gear
 * against a play triangle — never two marks that read alike at 14px, which is
 * why `document` sits beside `lock` rather than beside `spreadsheet`.
 */
const CATEGORIES: Record<FileTypeCategory, FileTypeIcon> = {
  source: { category: "source", Icon: FileCode, colorClass: "text-category-blue" },
  font: { category: "font", Icon: FileType, colorClass: "text-category-blue" },
  script: { category: "script", Icon: FileTerminal, colorClass: "text-category-cyan" },
  audio: { category: "audio", Icon: FileMusic, colorClass: "text-category-cyan" },
  data: { category: "data", Icon: FileBraces, colorClass: "text-category-amber" },
  spreadsheet: {
    category: "spreadsheet",
    Icon: FileSpreadsheet,
    colorClass: "text-category-amber",
  },
  config: { category: "config", Icon: FileCog, colorClass: "text-category-violet" },
  video: { category: "video", Icon: FilePlay, colorClass: "text-category-violet" },
  lock: { category: "lock", Icon: FileLock, colorClass: "text-category-indigo" },
  document: { category: "document", Icon: FileText, colorClass: "text-category-indigo" },
  image: { category: "image", Icon: FileImage, colorClass: "text-category-pink" },
  key: { category: "key", Icon: FileKey, colorClass: "text-category-pink" },
  archive: { category: "archive", Icon: FileArchive, colorClass: "text-category-orange" },
  binary: { category: "binary", Icon: Binary, colorClass: "text-category-orange" },
  // The only glyph that isn't a page at all, so it needs no partner to tell it apart.
  database: { category: "database", Icon: Database, colorClass: "text-category-teal" },
  unknown: { category: "unknown", Icon: File, colorClass: UNKNOWN_FILE_COLOR_CLASS },
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
 * Icon and color for one tree row, keyed off its name alone.
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
