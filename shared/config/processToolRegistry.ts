/**
 * Single source of truth for non-agent process detection: one entry per tool,
 * carrying its display label, the command names that resolve to it, and the
 * priority tier used when several processes in a PTY's tree match at once.
 *
 * The entry key IS the icon id. It resolves to `src/components/icons/brands/
 * <Key>Icon.tsx` through the same `import.meta.glob` that backs agent icons,
 * so there is no second component map to keep in sync. `npm run
 * check:process-tools` fails the build when an entry has no matching brand
 * file, which is what stops a missing icon or label from shipping silently.
 *
 * Deliberately static and built-in only. `ProcessDetector` imports this from
 * the pty-host utility process, and `shared/config` registries are per-process
 * singletons — plugin-contributed entries would need an explicit IPC mirror
 * replayed on every host restart. Module-level data needs none of that. #10601
 */

/**
 * Detection precedence when several processes match in one pass, best first.
 * `runtime` sits below `tool` so `node /path/to/vite.js` reports Vite rather
 * than Node; `package-manager` sits last so npm is the fallback when nothing
 * identifiable runs beneath it, not the winner.
 */
export type ProcessToolTier = "tool" | "runtime" | "package-manager";

export interface ProcessToolConfig {
  readonly label: string;
  readonly commands: readonly [string, ...string[]];
  readonly tier: ProcessToolTier;
}

export const PROCESS_TOOL_REGISTRY = {
  // Package managers
  npm: { label: "npm", commands: ["npm", "npx"], tier: "package-manager" },
  yarn: { label: "Yarn", commands: ["yarn"], tier: "package-manager" },
  pnpm: { label: "pnpm", commands: ["pnpm"], tier: "package-manager" },
  // `bun run x` is launcher usage like the rest of this tier, so it yields to
  // whatever it starts. When nothing identifiable runs below it, Bun wins.
  bun: { label: "Bun", commands: ["bun", "bunx"], tier: "package-manager" },
  composer: { label: "Composer", commands: ["composer"], tier: "package-manager" },
  uv: { label: "uv", commands: ["uv", "uvx"], tier: "package-manager" },
  poetry: { label: "Poetry", commands: ["poetry"], tier: "package-manager" },

  // Language runtimes — generic hosts, outranked by whatever they run
  node: { label: "Node.js", commands: ["node", "tsx"], tier: "runtime" },
  python: { label: "Python", commands: ["python", "python3", "uvicorn"], tier: "runtime" },
  ruby: { label: "Ruby", commands: ["ruby", "rails", "bundle"], tier: "runtime" },
  php: { label: "PHP", commands: ["php"], tier: "runtime" },
  deno: { label: "Deno", commands: ["deno"], tier: "runtime" },

  // Compiled languages
  go: { label: "Go", commands: ["go"], tier: "tool" },
  rust: { label: "Rust", commands: ["cargo", "rustc"], tier: "tool" },
  kotlin: { label: "Kotlin", commands: ["kotlin", "kotlinc"], tier: "tool" },
  swift: { label: "Swift", commands: ["swift", "swiftc"], tier: "tool" },
  elixir: { label: "Elixir", commands: ["elixir", "mix", "iex"], tier: "tool" },
  zig: { label: "Zig", commands: ["zig"], tier: "tool" },
  dotnet: { label: ".NET", commands: ["dotnet"], tier: "tool" },

  // Python tooling
  pytest: { label: "pytest", commands: ["pytest"], tier: "tool" },
  ruff: { label: "Ruff", commands: ["ruff"], tier: "tool" },

  // JavaScript tooling
  vite: { label: "Vite", commands: ["vite"], tier: "tool" },
  webpack: { label: "webpack", commands: ["webpack"], tier: "tool" },
  esbuild: { label: "esbuild", commands: ["esbuild"], tier: "tool" },
  turbo: { label: "Turborepo", commands: ["turbo"], tier: "tool" },
  nx: { label: "Nx", commands: ["nx"], tier: "tool" },
  vitest: { label: "Vitest", commands: ["vitest"], tier: "tool" },
  jest: { label: "Jest", commands: ["jest"], tier: "tool" },
  biome: { label: "Biome", commands: ["biome"], tier: "tool" },
  eslint: { label: "ESLint", commands: ["eslint"], tier: "tool" },
  prettier: { label: "Prettier", commands: ["prettier"], tier: "tool" },
  typescript: { label: "TypeScript", commands: ["tsc"], tier: "tool" },
  prisma: { label: "Prisma", commands: ["prisma"], tier: "tool" },

  // Build systems
  gradle: { label: "Gradle", commands: ["gradle", "gradlew"], tier: "tool" },
  make: { label: "Make", commands: ["make"], tier: "tool" },
  cmake: { label: "CMake", commands: ["cmake"], tier: "tool" },
  bazel: { label: "Bazel", commands: ["bazel"], tier: "tool" },
  just: { label: "just", commands: ["just"], tier: "tool" },
  maven: { label: "Maven", commands: ["mvn"], tier: "tool" },

  // Containers & infrastructure
  docker: { label: "Docker", commands: ["docker"], tier: "tool" },
  podman: { label: "Podman", commands: ["podman"], tier: "tool" },
  kubernetes: { label: "Kubernetes", commands: ["kubectl", "k9s"], tier: "tool" },
  helm: { label: "Helm", commands: ["helm"], tier: "tool" },
  terraform: { label: "Terraform", commands: ["terraform", "tofu"], tier: "tool" },

  // Cloud & tunnels
  cloudflare: { label: "Wrangler", commands: ["wrangler"], tier: "tool" },
  vercel: { label: "Vercel", commands: ["vercel"], tier: "tool" },
  netlify: { label: "Netlify", commands: ["netlify"], tier: "tool" },
  supabase: { label: "Supabase", commands: ["supabase"], tier: "tool" },
  firebase: { label: "Firebase", commands: ["firebase"], tier: "tool" },
  ngrok: { label: "ngrok", commands: ["ngrok"], tier: "tool" },
  stripe: { label: "Stripe", commands: ["stripe"], tier: "tool" },
  railway: { label: "Railway", commands: ["railway"], tier: "tool" },

  // Databases
  postgresql: { label: "PostgreSQL", commands: ["psql"], tier: "tool" },
  mysql: { label: "MySQL", commands: ["mysql"], tier: "tool" },
  mongodb: { label: "MongoDB", commands: ["mongosh"], tier: "tool" },
  redis: { label: "Redis", commands: ["redis-cli"], tier: "tool" },
  sqlite: { label: "SQLite", commands: ["sqlite3"], tier: "tool" },

  // Terminal tools
  github: { label: "GitHub CLI", commands: ["gh"], tier: "tool" },
  tmux: { label: "tmux", commands: ["tmux"], tier: "tool" },
  neovim: { label: "Neovim", commands: ["nvim"], tier: "tool" },
} as const satisfies Readonly<Record<string, ProcessToolConfig>>;

export type ProcessToolIconId = keyof typeof PROCESS_TOOL_REGISTRY;

const TIER_PRIORITY: Record<ProcessToolTier, number> = {
  tool: 1,
  runtime: 2,
  "package-manager": 3,
};

/**
 * Command name → icon id. Built by flattening `commands`, so an alias can
 * never disagree with the entry it belongs to. A duplicate alias resolves
 * last-wins rather than throwing: this module is evaluated in the pty-host
 * utility process, where a module-scope throw would take the host down over
 * a registry typo. `check:process-tools` rejects duplicates at build time.
 */
const PROCESS_TOOL_ICON_BY_COMMAND: Record<string, string> = Object.fromEntries(
  Object.entries(PROCESS_TOOL_REGISTRY).flatMap(([iconId, config]) =>
    config.commands.map((command) => [command, iconId] as const)
  )
);

export { PROCESS_TOOL_ICON_BY_COMMAND };

export function getProcessToolConfig(
  iconId: string | null | undefined
): ProcessToolConfig | undefined {
  // Own-key check: `iconId` reaches here from persisted panel state and from
  // plugin manifests, where a bare index would return an inherited member.
  if (!iconId || !Object.hasOwn(PROCESS_TOOL_REGISTRY, iconId)) return undefined;
  return PROCESS_TOOL_REGISTRY[iconId as ProcessToolIconId];
}

/**
 * Detection priority for a non-agent icon id. Unregistered ids (plugin-
 * contributed panel icons) rank alongside ordinary tools — they name
 * something specific, so they should not lose to a package manager.
 */
export function getProcessToolPriority(iconId: string | null | undefined): number {
  const config = getProcessToolConfig(iconId);
  return config ? TIER_PRIORITY[config.tier] : TIER_PRIORITY.tool;
}
