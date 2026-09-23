import { useId, useMemo } from "react";
import { ArrowDown, ArrowUp, X as XIcon } from "lucide-react";
import { FALLBACK_CHAIN_MAX } from "../../../../shared/config/agentRegistry";
import type { AgentPreset } from "@/config/agents";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SETTINGS_CONTROL_WIDTH, SettingsDependents, SettingsRow } from "../SettingsGroup";

interface FallbackChainEditorProps {
  selectedPreset: AgentPreset;
  allPresets: AgentPreset[];
  onUpdatePreset: (presetId: string, patch: Partial<AgentPreset>) => void;
}

/** Moves the entry at `from` one step towards `to`; out-of-range moves return the chain unchanged. */
export function moveFallback(chain: string[], from: number, to: number): string[] {
  if (from < 0 || from >= chain.length || to < 0 || to >= chain.length) return chain;
  const next = [...chain];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function FallbackChainEditor({
  selectedPreset,
  allPresets,
  onUpdatePreset,
}: FallbackChainEditorProps) {
  const chain = useMemo(() => selectedPreset.fallbacks ?? [], [selectedPreset.fallbacks]);

  const candidates = useMemo(
    () => allPresets.filter((p) => p.id !== selectedPreset.id && !chain.includes(p.id)),
    [allPresets, selectedPreset.id, chain]
  );

  const setChain = (fallbacks: string[]) => onUpdatePreset(selectedPreset.id, { fallbacks });

  // Moving or removing a fallback can take away the button that had focus — the
  // row goes, or its arrow disables at the end of the list. Once the chain has
  // re-rendered, put focus on the nearest control that still means something.
  const scopeId = useId();
  const focusAfterRender = (selectors: string[]) => {
    requestAnimationFrame(() => {
      for (const selector of selectors) {
        const el = document.querySelector<HTMLElement>(
          `[data-fallback-scope="${scopeId}"]${selector}`
        );
        if (el && !el.matches(":disabled")) {
          el.focus();
          return;
        }
      }
    });
  };
  const action = (id: string, kind: "up" | "down" | "remove") =>
    `[data-fallback-action="${id}:${kind}"]`;

  const move = (id: string, from: number, to: number) => {
    setChain(moveFallback(chain, from, to));
    const dir = to < from ? "up" : "down";
    const other = dir === "up" ? "down" : "up";
    focusAfterRender([action(id, dir), action(id, other)]);
  };

  const remove = (id: string, idx: number) => {
    const next = chain.filter((f) => f !== id);
    setChain(next);
    const neighbour = next[idx] ?? next[idx - 1];
    focusAfterRender([
      ...(neighbour ? [action(neighbour, "remove")] : []),
      '[data-fallback-add=""]',
    ]);
  };

  const addFallback = (id: string) => {
    if (!id || chain.includes(id) || chain.length >= FALLBACK_CHAIN_MAX) return;
    setChain([...chain, id]);
  };

  const canAdd = chain.length < FALLBACK_CHAIN_MAX && candidates.length > 0;
  const addStatus =
    chain.length >= FALLBACK_CHAIN_MAX
      ? `Maximum of ${FALLBACK_CHAIN_MAX} fallbacks reached`
      : candidates.length === 0
        ? "No other presets to fall back to"
        : null;

  return (
    <>
      <SettingsRow
        label="Fallback presets"
        description="Tried in order if this preset's provider is unreachable. No retry for rate limits or prompt errors"
        control={({ labelId, descriptionId, disabled }) =>
          canAdd ? (
            // Controlled at "" so the trigger shows its placeholder again after each
            // pick without remounting — a remount would drop keyboard focus.
            <Select value="" onValueChange={addFallback} disabled={disabled}>
              <SelectTrigger
                data-fallback-scope={scopeId}
                data-fallback-add=""
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                className={SETTINGS_CONTROL_WIDTH.select}
              >
                <SelectValue placeholder="Add a fallback" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.displayTitle ?? p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-xs text-text-secondary">{addStatus}</span>
          )
        }
      />
      {chain.length > 0 && (
        <SettingsDependents>
          {chain.map((id, idx) => {
            const preset = allPresets.find((p) => p.id === id);
            const name = preset?.displayTitle ?? preset?.name ?? id;
            const missing = !preset;
            return (
              <SettingsRow
                key={id}
                labelText={name}
                label={
                  <span className="flex items-baseline gap-2">
                    <span className="text-xs text-text-secondary font-mono tabular-nums">
                      {idx + 1}.
                    </span>
                    <span className="truncate">{name}</span>
                  </span>
                }
                description={missing ? "This preset no longer exists, so it is skipped" : undefined}
                className="py-2"
                control={({ disabled }) => (
                  <div className="flex items-center gap-1">
                    {/* Reordering needs something to reorder against. */}
                    {chain.length > 1 && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={disabled || idx === 0}
                          data-fallback-scope={scopeId}
                          data-fallback-action={`${id}:up`}
                          onClick={() => move(id, idx, idx - 1)}
                          aria-label={`Move ${name} up`}
                          title="Move up"
                        >
                          <ArrowUp aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={disabled || idx === chain.length - 1}
                          data-fallback-scope={scopeId}
                          data-fallback-action={`${id}:down`}
                          onClick={() => move(id, idx, idx + 1)}
                          aria-label={`Move ${name} down`}
                          title="Move down"
                        >
                          <ArrowDown aria-hidden="true" />
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled}
                      data-fallback-scope={scopeId}
                      data-fallback-action={`${id}:remove`}
                      onClick={() => remove(id, idx)}
                      aria-label={`Remove ${name} from fallback chain`}
                      title="Remove"
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  </div>
                )}
              />
            );
          })}
        </SettingsDependents>
      )}
    </>
  );
}
