// Reversible text form for an argv array edited in a single input. Quotes
// group words; backslashes are always literal so Windows paths survive
// unquoted. parseShellArgs(formatShellArgs(args)) returns args unchanged.

const PLAIN_ARG = /^[^\s"']+$/;

function quoteArg(arg: string): string {
  if (!arg.includes("'")) return `'${arg}'`;
  if (!arg.includes('"')) return `"${arg}"`;
  return arg
    .split(/('+)/)
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith("'") ? `"${segment}"` : `'${segment}'`))
    .join("");
}

export function formatShellArgs(args: readonly string[]): string {
  return args.map((arg) => (PLAIN_ARG.test(arg) ? arg : quoteArg(arg))).join(" ");
}

export function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
    } else if (/\s/.test(char)) {
      if (inToken) {
        args.push(current);
        current = "";
        inToken = false;
      }
    } else {
      current += char;
      inToken = true;
    }
  }
  if (inToken) args.push(current);
  return args;
}
