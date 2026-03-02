export const LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  mjs: "javascript",
  cjs: "javascript",
  html: "markup",
  htm: "markup",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "markup",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  dockerfile: "docker",
  makefile: "makefile",
  graphql: "graphql",
  gql: "graphql",
};

export function getLanguageForFile(filePath: string): string {
  const basename = (filePath.split("/").pop() ?? filePath).split("\\").pop() ?? filePath;
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex > 0) {
    const ext = basename.slice(dotIndex + 1).toLowerCase();
    if (LANGUAGE_MAP[ext]) return LANGUAGE_MAP[ext];
  }
  // Extensionless filenames: Dockerfile, Makefile, etc.
  return LANGUAGE_MAP[basename.toLowerCase()] || "text";
}
