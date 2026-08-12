/**
 * Pure classifier for git's textual binary-file marker.
 *
 * Git emits `Binary files <old> and <new> differ` at column 0 as diff metadata.
 * Every line inside a hunk carries a `+`, `-`, ` `, or `\` prefix, so anchoring
 * to the line start is what separates the real marker from a text file whose
 * own content happens to contain the phrase.
 *
 * The middle is left unconstrained: `--no-prefix`, custom `--src-prefix`/
 * `--dst-prefix`, `diff.mnemonicPrefix`, and `core.quotePath` all change how
 * the paths render. `/dev/null` appears on the added and deleted forms.
 *
 * Scope: git's normal diff output. `--binary` produces a `GIT binary patch`
 * payload instead, which no caller requests and this helper does not classify.
 *
 * Renderer-safe: no Node.js built-ins, no Electron deps.
 */
const BINARY_FILE_MARKER = /^Binary files .+ differ\r?$/m;

export function isBinaryDiffOutput(diffText: string): boolean {
  return BINARY_FILE_MARKER.test(diffText);
}
