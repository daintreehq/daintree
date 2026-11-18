/** One word of a shell command line, quotes and escapes taken off its value. */
interface CommandWord {
  value: string;
  start: number;
  end: number;
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function commandWords(command: string): CommandWord[] {
  const words: CommandWord[] = [];
  let index = 0;
  while (index < command.length) {
    while (isSpace(command[index])) index += 1;
    if (index >= command.length) break;
    const start = index;
    let value = "";
    while (index < command.length && !isSpace(command[index])) {
      const char = command[index] as string;
      if (char === "'") {
        const close = command.indexOf("'", index + 1);
        const end = close === -1 ? command.length : close;
        value += command.slice(index + 1, end);
        index = end + 1;
      } else if (char === '"') {
        index += 1;
        while (index < command.length && command[index] !== '"') {
          const escaped = command[index] === "\\" && index + 1 < command.length;
          value += escaped ? command[index + 1] : command[index];
          index += escaped ? 2 : 1;
        }
        index += 1;
      } else {
        value += char;
        index += 1;
      }
    }
    words.push({ value, start, end: Math.min(index, command.length) });
  }
  return words;
}

/**
 * Removes every occurrence of `args` from a launch command, word by word: an
 * option with its value as separate words or as `--option=value`, and a lone
 * option with any `=value` after it. A quoted word is one word whatever it
 * holds, so a prompt that mentions the option is left alone.
 */
export function stripCommandArgs(command: string, args: readonly string[]): string {
  const [option, ...values] = args;
  if (option === undefined) return command;
  const words = commandWords(command);
  const joined = values.length === 1 ? `${option}=${values[0]}` : undefined;
  const lengthAt = (index: number): number => {
    const value = words[index]?.value;
    if (value === undefined) return 0;
    if (values.length === 0) return value === option || value.startsWith(`${option}=`) ? 1 : 0;
    if (value === joined) return 1;
    return args.every((arg, offset) => words[index + offset]?.value === arg) ? args.length : 0;
  };
  let result = "";
  let copiedTo = 0;
  for (let index = 0; index < words.length;) {
    const length = lengthAt(index);
    if (length === 0) {
      index += 1;
      continue;
    }
    // The cut takes the whitespace before the first word along, so the words
    // around it keep their own spacing.
    const cutFrom = index === 0 ? 0 : (words[index - 1] as CommandWord).end;
    result += command.slice(copiedTo, cutFrom);
    copiedTo = (words[index + length - 1] as CommandWord).end;
    index += length;
  }
  return (result + command.slice(copiedTo)).trim();
}
