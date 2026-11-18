import path from "node:path";
import { tunnelArgProblem } from "../../../shared/utils/cloudProviderDeclaration.js";

export { sshDeclarationProblem } from "../../../shared/utils/cloudProviderDeclaration.js";

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The `ProxyCommand` value for a tunnel found at `commandPath`. Double quotes
 * keep a path with spaces whole in every shell, and nothing that any of them
 * reads inside double quotes is let through; a literal `%` is doubled so ssh
 * doesn't take it for a token.
 */
export function proxyCommandLine(commandPath: string, args: readonly string[]): string {
  if (
    !path.isAbsolute(commandPath) ||
    /["$`\\]/.test(commandPath) ||
    hasControlCharacter(commandPath)
  ) {
    throw new Error("Refusing to run an unusual path as an ssh ProxyCommand");
  }
  const words = [`"${commandPath.replace(/%/g, "%%")}"`];
  for (const arg of args) {
    const problem = tunnelArgProblem(arg);
    if (problem) throw new Error(problem);
    words.push(`"${arg}"`);
  }
  return words.join(" ");
}
