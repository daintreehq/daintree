import { Puzzle } from "lucide-react";
import {
  PROJECT_SURFACE_SLOT_CATALOGUE,
  type ProjectSurfaceChoice,
  type ProjectSurfaceSlot,
} from "@shared/types/plugin";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useFramedSurfaceSlots } from "@/components/Plugin/framedSurfaceSlots";
import { surfacePluginFallbackName } from "@/hooks/useProjectSurfaceRefusals";
import {
  claimedSurfaceSlots,
  consentHostSlot,
  surfaceAnswerUpdates,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";

/**
 * The one question a plugin's slots get in a project: "Acme set up this
 * project: Empty canvas", with Keep and Use Daintree's.
 *
 * One notice per plugin, not per slot. It lists every slot the plugin set up
 * that the user hasn't answered about, and one answer covers them all in a
 * single write. A slot already answered keeps its answer and is not listed, so
 * the notice never names a slot its buttons won't change. A plugin that claims
 * a slot it didn't before, or takes one over from another plugin, has an
 * unanswered slot again — so it asks again, with nothing stored to say it was
 * seen.
 *
 * Rendered by each slot's host frame for its own `slot`; only the frame of the
 * plugin's first unanswered slot on screen draws it, so several framed slots
 * still ask once. Not modal, and never inside the plugin's own box.
 *
 * Single-line by construction: a `title` and no `description`, the layout
 * `InlineStatusBanner` draws as one 40px row rather than a 112px card.
 */
export function ProjectSurfaceConsentNotice({
  slot,
  onAnswered,
}: {
  slot: ProjectSurfaceSlot;
  /** After the answer is recorded: the notice is gone, so focus needs a new home. */
  onAnswered: () => void;
}) {
  const slots = usePluginProjectSurfacesStore((s) => s.slots);
  const choices = usePluginProjectSurfacesStore((s) => s.choices);
  const choicesLoaded = usePluginProjectSurfacesStore((s) => s.choicesLoaded);
  const setSurfaceChoices = usePluginProjectSurfacesStore((s) => s.setSurfaceChoices);
  const framed = useFramedSurfaceSlots();
  const pluginId = slots[slot]?.defaultOptionId ?? null;
  const pluginDisplayName = useProjectPluginStore(
    (s) => s.plugins.find((p) => p.instanceId === pluginId)?.displayName
  );

  // Until main has answered, "no answer" is unknown rather than known, and a
  // project that answered long ago must not be asked again.
  if (pluginId === null || !choicesLoaded) return null;
  const claimed = claimedSurfaceSlots(slots, choices);
  if (consentHostSlot(claimed, pluginId, framed) !== slot) return null;

  const undecided = claimed.filter((entry) => entry.pluginId === pluginId && entry.choice === null);
  const labels = undecided.map((entry) => PROJECT_SURFACE_SLOT_CATALOGUE[entry.slot].label);
  const answer = async (choice: ProjectSurfaceChoice) => {
    // Only the unanswered slots: keeping a plugin's new slot is not turning
    // an old one the user switched off back on.
    await setSurfaceChoices(surfaceAnswerUpdates(undecided, choice));
    onAnswered();
  };

  return (
    <InlineStatusBanner
      icon={Puzzle}
      title={`${pluginDisplayName ?? surfacePluginFallbackName(pluginId)} set up this project: ${labels.join(", ")}`}
      severity="neutral"
      role="status"
      // Equal weight, deliberately: one variant, one size, both answers. Each
      // is a single click from being reversed — the slot's own switch, and the
      // reset in project plugin settings — so promoting either one is picking
      // for the user.
      actions={[
        {
          id: "keep",
          label: "Keep",
          variant: "primary",
          onClick: () => void answer("surface"),
        },
        {
          id: "stock",
          label: "Use Daintree's",
          variant: "primary",
          onClick: () => void answer("stock"),
        },
      ]}
    />
  );
}
