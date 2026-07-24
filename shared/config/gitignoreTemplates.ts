// Order drives the git-init dialog dropdown. Minimal is first because it is
// the default: it covers secrets, OS junk, editor state and AI-agent local
// state, and every language template is composed on top of it.
export const GITIGNORE_TEMPLATE_OPTIONS = [
  { value: "minimal", label: "Minimal", description: "OS, editor, secrets, agent state" },
  { value: "node", label: "Node / TypeScript", description: "node_modules, build output, caches" },
  { value: "python", label: "Python", description: "__pycache__, venvs, tooling caches" },
  { value: "rust", label: "Rust", description: "target/, rustfmt backups" },
  { value: "go", label: "Go", description: "binaries, test output, workspace files" },
  { value: "java", label: "Java / JVM", description: "Gradle and Maven output, class files" },
  { value: "php", label: "PHP / Laravel", description: "vendor/, storage, compiled assets" },
  { value: "ruby", label: "Ruby on Rails", description: "logs, tmp, bundler, credentials keys" },
  { value: "dotnet", label: "C# / .NET", description: "bin/, obj/, user files" },
  { value: "web", label: "Static web", description: "build output, tool caches" },
  { value: "none", label: "None", description: "Don't create a .gitignore" },
] as const;

export type GitignoreTemplateId = (typeof GITIGNORE_TEMPLATE_OPTIONS)[number]["value"];

export const DEFAULT_GITIGNORE_TEMPLATE_ID: GitignoreTemplateId = "minimal";

export function isGitignoreTemplateId(value: unknown): value is GitignoreTemplateId {
  return GITIGNORE_TEMPLATE_OPTIONS.some((option) => option.value === value);
}
