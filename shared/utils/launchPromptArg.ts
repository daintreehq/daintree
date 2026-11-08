import { agentCommandDialect, escapeShellArg, quotePowerShellArg } from "./shellEscape.js";

/**
 * A launch prompt as restore compares it (#15269): trimmed, with its line breaks
 * and tabs as spaces. Both sides go through this, so a conversation matches its
 * pane whichever way its first message arrived: with its line breaks, or on one
 * line, as every launch before #16378 sent it and a shell without the means to
 * build them still does.
 */
export function launchPromptMatchText(prompt: string): string {
  return prompt.trim().replace(/\r\n|[\n\t]/g, " ");
}

// The three quote and escape characters go by number, which leaves the word with
// no `'` or `"` of its own for anything scanning the command (`scanShellWords`)
// to trip on, and no `\\`, which fish's single quotes would halve before printf
// ever saw it.
const POSIX_PROMPT_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\0134",
  "'": "\\0047",
  '"': "\\0042",
  "\n": "\\n",
  "\t": "\\t",
};

function encodePosixPrompt(text: string): string {
  return text.replace(/[\\'"\n\t]/g, (char) => POSIX_PROMPT_ESCAPES[char] ?? char);
}

const POSIX_PROMPT_DECODES: Readonly<Record<string, string>> = {
  "\\0134": "\\",
  "\\0047": "'",
  "\\0042": '"',
  "\\n": "\n",
  "\\t": "\t",
};

function decodePosixPrompt(encoded: string): string {
  return encoded.replace(/\\0(?:134|047|042)|\\[nt]/g, (escape) => POSIX_PROMPT_DECODES[escape]!);
}

/**
 * Inside PowerShell's double quotes a backtick is the escape, `""` is a `"`, and
 * the typographic double quotes close the string just as `"` does.
 */
function quotePowerShellPrompt(text: string): string {
  const escaped = text.replace(/[`$"“-„\n\t]/g, (char) => {
    if (char === "\n") return "`n";
    if (char === "\t") return "`t";
    return char === '"' ? '""' : `\`${char}`;
  });
  return `"${escaped}"`;
}

/**
 * One argument of an agent launch command holding the prompt.
 *
 * A prompt with no line break or tab is a plain quoted literal. One with them
 * has the shell build them, so the command itself stays free of control
 * characters: `TerminalSpawnOptionsSchema` refuses any, because the command is
 * interpolated into a shell startup script. Every other byte of the prompt stays
 * inert data: `printf` reads it as an argument under a fixed format, and
 * PowerShell's double quotes get each of their specials escaped.
 */
export function quoteLaunchPrompt(prompt: string): string {
  const text = prompt.trim().replace(/\r\n/g, "\n");
  const windows = agentCommandDialect() === "windows";
  if (!/[\n\t]/.test(text)) {
    return windows ? quotePowerShellArg(text) : escapeShellArg(text, "posix");
  }
  return windows ? quotePowerShellPrompt(text) : `"$(printf '%b' '${encodePosixPrompt(text)}')"`;
}

// The encoded text holds no `'` or `"`, and a quoted literal escapes every `'`,
// so this can't match inside anything but the word it was built as.
const POSIX_PROMPT_WORD = /"\$\(printf '%b' '([^'"]*)'\)"/g;

/**
 * A launch command as typed into a shell that can't host the startup wrapper
 * (`buildCommandLaunchShell`). fish only reads `"$(...)"` from 3.4, so it gets
 * the form every fish since 3.1 reads, and nushell's double quotes take JSON's
 * escapes without expanding anything. Any other such shell (tcsh, xonsh) has no
 * form to rely on and gets the prompt on one line, with no literal tab for its
 * line editor to read as completion.
 */
export function typedLaunchCommand(command: string, shell: string): string {
  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return command.replace(POSIX_PROMPT_WORD, (_word, encoded: string) => {
    if (name === "fish") return `(printf '%b' '${encoded}' | string collect)`;
    const text = decodePosixPrompt(encoded);
    if (name === "nu") return JSON.stringify(text);
    return escapeShellArg(launchPromptMatchText(text), "posix");
  });
}
