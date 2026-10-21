/** Git's regular-file and symlink modes; a symlink's content is its target path. */
export type NewFileMode = "100644" | "120000";

/**
 * The diff git would print for a file that is all new: one added line per
 * line, a trailing newline ending the last line rather than starting another,
 * and git's marker when the file doesn't end in one.
 */
export function newFileDiff(
  gitPath: string,
  content: string,
  mode: NewFileMode = "100644"
): string {
  const header = `diff --git a/${gitPath} b/${gitPath}
new file mode ${mode}
--- /dev/null
+++ b/${gitPath}`;
  // An empty file keeps the single empty added line it has always shown.
  if (content.length === 0) return `${header}\n@@ -0,0 +1,1 @@\n+`;
  const terminated = content.endsWith("\n");
  const lines = (terminated ? content.slice(0, -1) : content).split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  return `${header}\n@@ -0,0 +1,${lines.length} @@\n${body}${
    terminated ? "\n" : "\n\\ No newline at end of file"
  }`;
}
