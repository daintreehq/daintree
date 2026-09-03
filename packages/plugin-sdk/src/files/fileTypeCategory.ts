/**
 * Filename-based file-type classification, shared by Daintree's own file
 * browser and by plugins presenting their own file listings.
 *
 * Deliberately carries no icons and no styling. The category is the durable,
 * curated part — several hundred extensions and basenames, plus the patterns
 * that catch `.eslintrc.json`, `Dockerfile.dev` and `compose.override.yaml` —
 * while which glyph paints it is the consuming UI's business. That split is
 * what lets this ship in the plugin SDK without dragging an icon library or a
 * Tailwind class vocabulary along with it.
 *
 * `ts` is TypeScript, not MPEG transport stream: this is an IDE, and the cost
 * of the two readings is wildly asymmetric.
 */

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
 * Classify one file by its name alone.
 *
 * Resolution runs exact basename → pattern → extension → unknown, so the most
 * specific reading of a name always wins. Every step is an O(1) lookup or a
 * short fixed pattern list against module-scope constants, so there is nothing
 * here worth memoizing even when called per visible row.
 *
 * Filename-only by design — no MIME sniffing, no `stat`, no extra round trip.
 * The caller already has the name and nothing else is worth paying for per row.
 */
export function getFileTypeCategory(filePath: string): FileTypeCategory {
  const basename = basenameOf(filePath);

  // `Object.hasOwn` rather than a bare lookup: these tables are plain objects,
  // so a file genuinely named `constructor` or `__proto__` would otherwise read
  // an inherited member and hand back something that is not a category at all,
  // from a signature that promises it never does.
  if (Object.hasOwn(BASENAME_CATEGORIES, basename)) {
    return BASENAME_CATEGORIES[basename]!;
  }

  for (const [pattern, category] of BASENAME_PATTERNS) {
    if (pattern.test(basename)) return category;
  }

  // `dotIndex > 0` keeps a leading dot from reading as an extension:
  // `.gitignore` is a whole name, not an entry with a `gitignore` suffix.
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex > 0) {
    const extension = basename.slice(dotIndex + 1);
    if (Object.hasOwn(EXTENSION_CATEGORIES, extension)) {
      return EXTENSION_CATEGORIES[extension]!;
    }
  }

  return "unknown";
}
