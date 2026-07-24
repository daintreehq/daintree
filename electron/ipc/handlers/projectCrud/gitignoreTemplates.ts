import type { GitignoreTemplateId } from "../../../../shared/config/gitignoreTemplates.js";

type LanguageTemplateId = Exclude<GitignoreTemplateId, "minimal" | "none">;

// Baseline every language template is composed on top of. Patterns are ordered
// deliberately: a negation only takes effect after the rule it undoes, and git
// cannot re-include a file whose parent directory is excluded — hence
// `.vscode/*` rather than `.vscode/`. Do not sort or deduplicate.
const MINIMAL_TEMPLATE = `# Environment and secrets
.env
.env.*
!.env.example
!.env.sample
!.env.template
*.pem
*.p12
*.pfx
*.jks
*.keystore
.netrc
id_rsa
id_ecdsa
id_ed25519

# Logs
*.log
logs/

# macOS
.DS_Store
._*
.Spotlight-V100
.Trashes

# Windows
Thumbs.db
ehthumbs.db
[Dd]esktop.ini
$RECYCLE.BIN/

# Linux
.Trash-*
.fuse_hidden*
.directory

# Editors
*.swp
*.swo
*~
.vscode/*
!.vscode/settings.json
!.vscode/tasks.json
!.vscode/launch.json
!.vscode/extensions.json
!.vscode/*.code-snippets
.idea/**/workspace.xml
.idea/**/tasks.xml
.idea/**/usage.statistics.xml
.idea/**/shelf/
*.iml

# AI agent local state
.claude/settings.local.json
CLAUDE.local.md
AGENTS.local.md
.codex/auth.json
.codex/sessions/
.aider*
!.aider.conf.yml
.cursor/rules/personal.mdc
.specstory/
.windsurf/

# Daintree
.daintree/*.local.json
`;

// Language-specific layers only — the Minimal baseline above supplies the OS,
// editor, secrets and agent-state coverage, so none of these restate it.
const LANGUAGE_LAYERS = {
  node: `# Dependencies
node_modules/
jspm_packages/
web_modules/

# Yarn Berry (commit releases, plugins, patches, sdks)
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/sdks
!.yarn/versions
.pnp.*
.yarn-integrity

# npm / pnpm
.npm
.pnpm-store/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
lerna-debug.log*
.pnpm-debug.log*

# Build output
/dist/
/build/
/out/
.next/
.nuxt/
.svelte-kit/
.astro/
.angular/
.output/
.vercel/

# Caches
.turbo/
.parcel-cache/
.rollup.cache/
.vite/
.eslintcache
.stylelintcache
*.tsbuildinfo

# Test and coverage
coverage/
*.lcov
.nyc_output/
/test-results/
/playwright-report/

# Runtime
pids/
*.pid
*.seed
*.pid.lock
report.[0-9]*.[0-9]*.[0-9]*.[0-9]*.json
*.tgz
`,

  python: `# Bytecode
__pycache__/
*.py[cod]
*$py.class
*.so

# Virtual environments (anchored, so src/env/ survives)
/env/
/venv/
/ENV/
/.venv/
/.pixi/

# Packaging
/build/
/dist/
*.egg-info/
.eggs/
*.egg
MANIFEST

# Tooling caches
.pytest_cache/
.ruff_cache/
.mypy_cache/
.tox/
.nox/
.dmypy.json
.pdm-build/

# Coverage
.coverage
.coverage.*
coverage.xml
htmlcov/

# Notebooks
.ipynb_checkpoints/

# direnv
.envrc
`,

  rust: `# Cargo build output
target/
debug/

# rustfmt backups
**/*.rs.bk

# MSVC debug info
*.pdb

# cargo-mutants
**/mutants.out*/
`,

  go: `# Binaries
*.exe
*.exe~
*.dll
*.so
*.dylib

# Test binaries and coverage
*.test
*.out
coverage.*
*.coverprofile
profile.cov

# Workspace files (local only)
go.work
go.work.sum

# Vendor directory. Uncomment if you rely on the module proxy instead.
# vendor/
`,

  java: `# Compiled output
*.class
target/
**/build/
!**/src/**/build/

# Gradle
.gradle/
.kotlin/
gradle-app.setting
.gradletasknamecache

# Wrappers must stay committed
!gradle/wrapper/gradle-wrapper.jar
!gradle/wrapper/gradle-wrapper.properties
!.mvn/wrapper/maven-wrapper.jar

# Maven
pom.xml.tag
pom.xml.releaseBackup
pom.xml.versionsBackup
pom.xml.next
release.properties
dependency-reduced-pom.xml
buildNumber.properties
.mvn/timing.properties

# JVM crash logs
hs_err_pid*
replay_pid*

# Eclipse
.project
.classpath
.settings/
.factorypath
`,

  php: `# Dependencies
/vendor/
composer.phar

# Laravel runtime
/bootstrap/cache/*
!/bootstrap/cache/.gitignore
/storage/*.key
/storage/pail
/public/build
/public/hot

# public/storage is a symlink, not real content
/public/storage
/public_html/storage
/public_html/hot

# Local config and secrets
.env.backup
Homestead.yaml
Homestead.json
/.vagrant
auth.json

# Testing
.phpunit.result.cache
.phpactor.json
`,

  ruby: `# Logs and temp
/log/*
/tmp/*
!/log/.keep
!/tmp/.keep

# ActiveStorage local disk
/storage/*
!/storage/.keep

# Bundler
/.bundle
/vendor/bundle

# Credentials keys (never commit)
/config/master.key
/config/credentials/*.key

# Databases
/db/*.sqlite3
/db/*.sqlite3-journal
/db/*.sqlite3-[0-9]*

# Test artifacts
/coverage/
/spec/tmp
capybara-*.html
rerun.txt
*.rbc
`,

  dotnet: `# Build output
[Bb]in/
[Oo]bj/
[Dd]ebug/
[Rr]elease/
[Ll]og/
[Ll]ogs/

# User files
*.user
*.userosscache
*.suo
*.sln.docstates
*.userprefs

# Test results
[Tt]est[Rr]esult*/
[Bb]uild[Ll]og.*

# Local secrets
appsettings.Development.json
appsettings.Local.json
*.publishsettings
`,

  web: `# Dependencies (Tailwind, Vite, PostCSS and friends)
node_modules/

# Build output
/dist/
/build/
/_site/
/public/build/

# Tool caches
.sass-cache/
.parcel-cache/
.eslintcache
.cache/
`,
} satisfies Record<LanguageTemplateId, string>;

function isLanguageTemplateId(value: string): value is LanguageTemplateId {
  return Object.hasOwn(LANGUAGE_LAYERS, value);
}

/**
 * Resolves a template id to `.gitignore` content. Returns `null` for `"none"`
 * and for unknown ids — the caller treats both as "nothing to write".
 */
export function getGitignoreTemplate(template: string): string | null {
  if (template === "minimal") return MINIMAL_TEMPLATE;
  if (!isLanguageTemplateId(template)) return null;
  return `${MINIMAL_TEMPLATE}\n${LANGUAGE_LAYERS[template]}`;
}
