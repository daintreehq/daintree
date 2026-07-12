/**
 * Shared so the renderer can prefill a create-scratch input with exactly the
 * name the main process would otherwise persist. Any drift between the two
 * would silently rename a scratch the user never edited.
 */
export function defaultScratchName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Scratch ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
