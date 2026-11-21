import { landOnSettingsElement } from "@/components/Settings/settingsLanding";

export const AGENTS_SECTION_ID = "decisions-agents";

/** Takes the person to Agents, where each agent's ask_human switch is: in view, its first switch focused. */
export function landOnAgents(): void {
  const section = document.getElementById(AGENTS_SECTION_ID);
  if (section) landOnSettingsElement(section);
}
