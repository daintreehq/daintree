/**
 * Shared utility for parsing text to extract code blocks and patches.
 * Used by browser/worker artifact extraction.
 */

export interface CodeBlock {
  language: string;
  content: string;
}

export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const language = match[1] || "text";
    const content = match[2].trim();
    if (content) {
      blocks.push({ language, content });
    }
  }

  return blocks;
}

export function extractPatches(text: string): string[] {
  const patches: string[] = [];
  const lines = text.split("\n");
  let currentPatch: string[] = [];
  let inPatch = false;

  for (const line of lines) {
    if (line.startsWith("diff ") || line.startsWith("---")) {
      if (inPatch && currentPatch.length > 0) {
        patches.push(currentPatch.join("\n"));
      }
      currentPatch = [line];
      inPatch = true;
    } else if (inPatch) {
      if (
        line.startsWith("+++") ||
        line.startsWith("@@") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ")
      ) {
        currentPatch.push(line);
      } else if (line.trim() === "") {
        currentPatch.push(line);
      } else {
        if (currentPatch.length > 3) {
          patches.push(currentPatch.join("\n"));
        }
        currentPatch = [];
        inPatch = false;
      }
    }
  }

  if (inPatch && currentPatch.length > 3) {
    patches.push(currentPatch.join("\n"));
  }

  return patches;
}

export function extractPatchFilename(patch: string): string | undefined {
  const match = patch.match(/^\+\+\+ b\/(.+)$/m) || patch.match(/^---\s*a\/(.+)$/m);
  return match ? match[1] : undefined;
}

export function suggestFilename(language: string, content: string): string | undefined {
  const extensionMap: Record<string, string> = {
    typescript: ".ts",
    javascript: ".js",
    tsx: ".tsx",
    jsx: ".jsx",
    python: ".py",
    ruby: ".rb",
    rust: ".rs",
    go: ".go",
    java: ".java",
    cpp: ".cpp",
    c: ".c",
    html: ".html",
    css: ".css",
    json: ".json",
    yaml: ".yaml",
    yml: ".yml",
    markdown: ".md",
    sql: ".sql",
    bash: ".sh",
    shell: ".sh",
  };

  const extension = extensionMap[language.toLowerCase()];
  if (!extension) {
    return undefined;
  }

  let name = "code";

  const classMatch = content.match(/(?:export\s+)?(?:class|interface)\s+(\w+)/);
  if (classMatch) {
    name = classMatch[1];
  }

  const functionMatch = content.match(/(?:export\s+)?(?:function|const)\s+(\w+)/);
  if (functionMatch && !classMatch) {
    name = functionMatch[1];
  }

  const pythonMatch = content.match(/(?:class|def)\s+(\w+)/);
  if (pythonMatch && language === "python") {
    name = pythonMatch[1];
  }

  return name + extension;
}

export function stripAnsiCodes(text: string): string {
  // More comprehensive ANSI escape code stripping
  // Handles CSI, OSC, DCS, and other control sequences
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ""
  );
}
