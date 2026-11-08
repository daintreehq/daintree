import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import type { ZodError } from "zod";
import { PromptTemplateContributionSchema } from "../schemas/plugin/content.js";
import { findPromptTemplateProblems } from "../schemas/plugin/validation/content.js";
import { PROMPT_TEMPLATE_MAX_BODY_LENGTH } from "../../shared/utils/pluginPromptTemplates.js";
import type { PromptTemplateContribution } from "../../shared/types/plugin.js";
import type {
  UserPromptTemplateProblem,
  UserPromptTemplatesSnapshot,
} from "../../shared/types/ipc/userPromptTemplates.js";
import { readBoundedFromHandle } from "../utils/boundedRead.js";
import { YAML_MERGE_SCHEMA } from "../utils/yamlMergeSchema.js";

// Far past the largest template the contract allows, so the cap only ever
// meets a file that was never meant to be one.
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 100;
const MARKDOWN_EXTENSION = ".md";
const MAX_REASONS_PER_FILE = 3;

// A closing fence is a full line of its own, so a `---notclose` line or a
// horizontal rule in the prompt is never taken for it.
const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?=\r?\n|$)(?:\r?\n)*/;

// The file's name and the text after its fences supply `id` and `body`, so a
// frontmatter that also sets one is refused with the other unknown keys.
const FrontmatterSchema = PromptTemplateContributionSchema.omit({ id: true, body: true });

export type ParsedUserPromptTemplate =
  | { template: PromptTemplateContribution }
  | { reason: string };

export function getUserPromptTemplatesDir(): string {
  return path.join(os.homedir(), ".daintree", "templates");
}

function describeIssues(error: ZodError): string {
  const reasons = error.issues.map((issue) => {
    const field = issue.path.join(".");
    if (field === "") return issue.message;
    if (issue.code === "invalid_type" && issue.message.endsWith("received undefined")) {
      return `${field} is missing`;
    }
    return `${field}: ${issue.message}`;
  });
  return reasons.slice(0, MAX_REASONS_PER_FILE).join("; ");
}

function readFrontmatter(block: string): { value: unknown } | { reason: string } {
  // js-yaml throws on an empty document; an empty block is an empty mapping,
  // and the schema names what's missing from it.
  if (block.trim() === "") return { value: {} };
  try {
    return { value: parseYaml(block, { schema: YAML_MERGE_SCHEMA }) };
  } catch (err) {
    const { reason, mark } = err as { reason?: string; mark?: { line?: number } };
    // The exception's own message quotes the source. A line in the file (one
    // past the opening fence) says where without repeating it.
    const where = typeof mark?.line === "number" ? ` on line ${mark.line + 2}` : "";
    return { reason: `The frontmatter isn't valid YAML${where}: ${reason ?? "parse error"}` };
  }
}

export function parseUserPromptTemplate(id: string, raw: string): ParsedUserPromptTemplate {
  const match = raw.match(FRONTMATTER_PATTERN);
  if (!match) {
    return { reason: "There's no frontmatter. Start the file with a --- block" };
  }
  const frontmatter = readFrontmatter(match[1] ?? "");
  if ("reason" in frontmatter) return frontmatter;

  const parsed = FrontmatterSchema.safeParse(frontmatter.value);
  if (!parsed.success) return { reason: describeIssues(parsed.error) };

  const body = raw.slice(match[0].length).trimEnd();
  if (body.trim() === "") return { reason: "There's no prompt text after the frontmatter" };
  if (body.length > PROMPT_TEMPLATE_MAX_BODY_LENGTH) {
    return {
      reason: `The prompt text is over the ${PROMPT_TEMPLATE_MAX_BODY_LENGTH}-character limit`,
    };
  }

  const template: PromptTemplateContribution = { id, ...parsed.data, body };
  const problems = findPromptTemplateProblems(template);
  if (problems.length > 0) {
    return {
      reason: problems
        .slice(0, MAX_REASONS_PER_FILE)
        .map((problem) => problem.message)
        .join("; "),
    };
  }
  return { template };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** The file's text, a reason it can't be used, or null if it has since gone. */
async function readTemplateFile(filePath: string): Promise<{ text: string } | { reason: string } | null> {
  let handle: fs.FileHandle;
  try {
    // Links are followed: this is the person's own folder, and a dotfiles setup
    // links files into place. O_NONBLOCK keeps a FIFO from hanging the read.
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    return { reason: `The file couldn't be read (${errorCode(err) ?? "unknown error"})` };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { reason: "It isn't a regular file" };
    const buffer = await readBoundedFromHandle(handle, stat.size, MAX_FILE_BYTES);
    if (buffer === null) return { reason: `It's larger than ${MAX_FILE_BYTES / 1024} KB` };
    try {
      return { text: utf8.decode(buffer) };
    } catch {
      return { reason: "It isn't valid UTF-8" };
    }
  } catch (err) {
    return { reason: `The file couldn't be read (${errorCode(err) ?? "unknown error"})` };
  } finally {
    await handle.close();
  }
}

/**
 * Reads the folder as it stands. There's no watcher and nothing held between
 * calls: the list is only ever seen when a `/` menu or the settings page opens,
 * and each of those asks again, so a saved file shows the next time anyone
 * looks. A half-saved file is reported this once and gone on the next read. A
 * missing folder is the normal empty state and is not created.
 */
export async function readUserPromptTemplates(
  directory: string = getUserPromptTemplatesDir()
): Promise<UserPromptTemplatesSnapshot> {
  const templates: PromptTemplateContribution[] = [];
  const problems: UserPromptTemplateProblem[] = [];

  let names: string[];
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    names = entries
      .filter(
        (entry) =>
          (entry.isFile() || entry.isSymbolicLink()) &&
          entry.name.endsWith(MARKDOWN_EXTENSION) &&
          !entry.name.startsWith(".")
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if (errorCode(err) !== "ENOENT") {
      problems.push({
        fileName: null,
        reason: `The folder couldn't be read (${errorCode(err) ?? "unknown error"})`,
      });
    }
    return { directory, templates, problems };
  }

  if (names.length > MAX_FILES) {
    problems.push({
      fileName: null,
      reason: `Only the first ${MAX_FILES} Markdown files in the folder are read`,
    });
  }
  for (const fileName of names.slice(0, MAX_FILES)) {
    const file = await readTemplateFile(path.join(directory, fileName));
    if (file === null) continue;
    if ("reason" in file) {
      problems.push({ fileName, reason: file.reason });
      continue;
    }
    const parsed = parseUserPromptTemplate(fileName.slice(0, -MARKDOWN_EXTENSION.length), file.text);
    if ("reason" in parsed) problems.push({ fileName, reason: parsed.reason });
    else templates.push(parsed.template);
  }
  return { directory, templates, problems };
}

/** Only an explicit open creates the folder. Daintree ships no templates to put in it. */
export async function ensureUserPromptTemplatesDir(
  directory: string = getUserPromptTemplatesDir()
): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  return directory;
}
