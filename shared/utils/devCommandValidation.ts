export function getInvalidCommandMessage(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "No dev command configured";
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return "Multi-line commands are not allowed";
  }
  return null;
}
