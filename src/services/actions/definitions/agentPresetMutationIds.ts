/**
 * The three user-preset writes on the action surface (#16047), planned once for
 * the confirm preview and again by the run against the store it writes.
 *
 * A model-written preset can't go through the sanitiser the way Settings'
 * presets do. `sanitizePreset` only runs when presets are read, so anything it
 * would drop or rewrite (an arg with a shell metacharacter, `PATH` in env) would
 * be stored as approved and then quietly vanish at launch. The plan refuses
 * those instead, naming each field, so the caller can fix the call before the
 * user is asked and the preview shows exactly what launches will use.
 */
export const AGENT_PRESET_MUTATION_ACTION_IDS = [
  "agent.createPreset",
  "agent.updatePreset",
  "agent.deletePreset",
] as const;

export type AgentPresetMutationActionId = (typeof AGENT_PRESET_MUTATION_ACTION_IDS)[number];

export function isAgentPresetMutationAction(id: string): id is AgentPresetMutationActionId {
  return (AGENT_PRESET_MUTATION_ACTION_IDS as readonly string[]).includes(id);
}
