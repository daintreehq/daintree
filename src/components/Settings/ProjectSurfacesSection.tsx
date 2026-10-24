import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { useBuildSkewUpdate } from "@/components/Hosts/buildSkew";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { RowFailure } from "@/components/Settings/projectPluginsShared";
import { renderableSurfaceClaim, usePanelKindRegistry } from "@/hooks/useRenderableSurfaceClaim";
import {
  describeSurfaceRefusal,
  surfacePluginFallbackName,
} from "@/hooks/useProjectSurfaceRefusals";
import {
  selectFailedSave,
  selectSurfaceChoice,
  surfaceAnswerUpdates,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import {
  isFileEditorSlotKey,
  orderedProjectSurfaceSlots,
  projectSurfaceClaimFromState,
  projectSurfaceSlotDescriptor,
  type ProjectSurfaceSlotKey,
} from "@shared/types/plugin";

/**
 * `text` as a closed sentence. A slot row's description runs several sentences
 * together, and some of the refusal wording it borrows is written to stand alone
 * without a period.
 */
function asSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

const SURFACE_SLOT_STATUS = {
  none: "You haven't chosen yet, so it shows.",
  surface: "You chose to keep it.",
  stock: "You chose Daintree's own, so it's hidden.",
} as const;

// A default editor hides nothing either way — every editor stays in the file
// panel's mode toggle — so its status says what a matching file opens in.
const FILE_EDITOR_SLOT_STATUS = {
  none: "You haven't chosen yet, so matching files open in it.",
  surface: "You chose to keep it, so matching files open in it.",
  stock: "You chose Daintree's own, so matching files open in Source.",
} as const;

/**
 * Every place in Daintree a plugin set up for this project — which plugin, the
 * user's remembered answer about it, and any plugin whose claim on it isn't
 * shown — with the way back to Daintree's own and a reset.
 *
 * The answers persist, so they have to be findable: without this, a project
 * whose owner once chose Daintree's own would keep hiding what its plugin still
 * claims, with nothing anywhere saying why. A framed slot is listed only while
 * its claim can render and its answer is known — the frame's own test — so this
 * never describes a surface the slot would not draw.
 */
export function ProjectSurfacesSection() {
  const init = usePluginProjectSurfacesStore((s) => s.init);
  const slots = usePluginProjectSurfacesStore((s) => s.slots);
  const choicesLoaded = usePluginProjectSurfacesStore((s) => s.choicesLoaded);
  const readFailure = usePluginProjectSurfacesStore((s) => s.readFailure);
  const update = useBuildSkewUpdate();
  const registry = usePanelKindRegistry();

  useEffect(() => {
    init();
  }, [init]);

  // Nothing here can say what plugins set up, so it says why instead of
  // leaving the page to look as if they set up nothing.
  if (readFailure !== null) {
    return (
      <div data-testid="project-plugins-surfaces">
        <SettingsSection title="Set up by plugins">
          <Callout
            severity="warning"
            role="status"
            title="Couldn't read what plugins set up here"
            action={
              update && (
                <Button type="button" variant="outline" size="sm" onClick={update.onClick}>
                  {update.label}
                </Button>
              )
            }
          >
            <p className="select-text">{readFailure}</p>
          </Callout>
        </SettingsSection>
      </div>
    );
  }
  if (!choicesLoaded) return null;
  const listed = orderedProjectSurfaceSlots(slots).filter((slot) => {
    const state = slots[slot];
    if (state === undefined) return false;
    if (state.defaultOptionId === null) return state.refused.length > 0;
    const { mode, claim } = projectSurfaceSlotDescriptor(slot);
    if (mode !== "exclusive" || claim !== "view") return true;
    return renderableSurfaceClaim(projectSurfaceClaimFromState(state), registry) !== null;
  });
  if (listed.length === 0) return null;

  return (
    <div data-testid="project-plugins-surfaces">
      <SettingsSection
        title="Set up by plugins"
        description="Where this project's plugins replace what Daintree draws"
      >
        <SettingsGroup>
          {listed.map((slot) => (
            <ProjectSurfaceRow key={slot} slot={slot} />
          ))}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}

/**
 * One slot: who set it up and what the user said about it. The switch is the
 * way back to Daintree's own; the reset forgets the answer, so the plugin's
 * version shows again and the slot is asked about the next time it appears.
 */
function ProjectSurfaceRow({ slot }: { slot: ProjectSurfaceSlotKey }) {
  const { label, noun } = projectSurfaceSlotDescriptor(slot);
  const status = isFileEditorSlotKey(slot) ? FILE_EDITOR_SLOT_STATUS : SURFACE_SLOT_STATUS;
  const state = usePluginProjectSurfacesStore((s) => s.slots[slot]);
  const choice = usePluginProjectSurfacesStore((s) => selectSurfaceChoice(s, slot));
  const failedSave = usePluginProjectSurfacesStore((s) => selectFailedSave(s, slot));
  const setSurfaceChoice = usePluginProjectSurfacesStore((s) => s.setSurfaceChoice);
  const setSurfaceChoices = usePluginProjectSurfacesStore((s) => s.setSurfaceChoices);
  const plugins = useProjectPluginStore((s) => s.plugins);
  const nameOf = (pluginId: string) =>
    plugins.find((p) => p.instanceId === pluginId)?.displayName ??
    surfacePluginFallbackName(pluginId);

  const owner = state?.defaultOptionId ?? null;
  const ownerName = owner === null ? null : nameOf(owner);

  return (
    <SettingsRow
      label={label}
      rootAttributes={{ "data-testid": `project-surface-row-${slot}` }}
      description={
        <>
          <span className="block">
            {ownerName === null
              ? "Daintree's own is showing."
              : `Set up by ${ownerName}. ${status[choice ?? "none"]}`}
          </span>
          {state?.refused.map((refusal) => (
            <span key={`${refusal.pluginId}:${refusal.reason}`} className="block">
              {`${nameOf(refusal.pluginId)}'s claim isn't shown: ${asSentence(describeSurfaceRefusal(refusal, nameOf).detail)}`}
            </span>
          ))}
        </>
      }
      isModified={choice !== null}
      onReset={() => void setSurfaceChoice(slot, null)}
      resetAriaLabel={`Ask again about the ${noun}`}
      resetTestId={`project-surface-reset-${slot}`}
      error={
        failedSave !== null ? (
          <RowFailure
            summary={`Couldn't save the ${noun} choice`}
            onRetry={() => void setSurfaceChoices(failedSave.updates)}
          />
        ) : undefined
      }
      control={
        owner === null
          ? undefined
          : ({ descriptionId }) => (
              <SettingsSwitch
                checked={choice !== "stock"}
                onCheckedChange={(next) =>
                  void setSurfaceChoices(
                    surfaceAnswerUpdates(
                      [{ slot, pluginId: owner, choice }],
                      next ? "surface" : "stock"
                    )
                  )
                }
                aria-label={`Use ${ownerName}'s ${noun}`}
                aria-describedby={descriptionId}
                data-testid={`project-surface-switch-${slot}`}
              />
            )
      }
    />
  );
}
