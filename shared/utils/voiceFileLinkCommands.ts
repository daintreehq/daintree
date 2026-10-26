// Explicit command vocabulary only. Bare "open", "reference" and "at" are
// everyday words in technical speech ("open a PR", "at the top of the file"),
// and every utterance that passes costs a detection call that can turn
// ordinary words into an @ reference.
export const FILE_LINK_COMMAND_PATTERN = String.raw`(?:link\s+to|(?:at|add|insert|reference)[\s-]+file)`;

const FILE_LINK_TRIGGER_RE = new RegExp(String.raw`\b${FILE_LINK_COMMAND_PATTERN}\b`, "i");

/** Whether an utterance says one of the commands that insert a file reference. */
export function mayReferenceFile(utterance: string): boolean {
  return FILE_LINK_TRIGGER_RE.test(utterance);
}
