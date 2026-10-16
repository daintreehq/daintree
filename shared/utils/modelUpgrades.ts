/**
 * The model a CLI would have `modelId` launch as today: follows the CLI's own
 * upgrade pointers (`gpt-5.6-sol` → `gpt-6-sol` → …) to the first ID with no
 * successor. An ID the map doesn't name, including any custom slug, comes back
 * unchanged. A cycle stops at the last ID before it repeats rather than
 * looping, so a malformed catalog can never stall a launch.
 */
export function followModelUpgrades(
  modelId: string,
  upgrades: Readonly<Record<string, string>> | undefined
): string {
  if (!upgrades) return modelId;
  const seen = new Set<string>([modelId]);
  let current = modelId;
  while (Object.hasOwn(upgrades, current)) {
    const next = upgrades[current];
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}
