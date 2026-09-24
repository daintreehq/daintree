import { useEffect, useMemo, useRef, useState } from "react";
import {
  BUILT_IN_SCHEMES,
  DEFAULT_SCHEME_ID,
  type TerminalColorScheme,
} from "@/config/terminalColorSchemes";
import { useTerminalColorSchemeStore } from "@/store/terminalColorSchemeStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { terminalConfigClient } from "@/clients/terminalConfigClient";
import { getTerminalThemeFromAppScheme, relativeLuminance, resolveAppTheme } from "@shared/theme";
import { logError } from "@/utils/logger";
import { Button } from "@/components/ui/button";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ThemeSelector } from "./ThemeSelector";

export interface ColorSchemeError {
  title: string;
  description: string;
  retry: () => void;
}

type Tone = "dark" | "light";

const TONE_OPTIONS: { value: Tone; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export function SchemePreview({
  scheme,
  fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize = "var(--text-4xs)",
}: {
  scheme: TerminalColorScheme;
  fontFamily?: string;
  fontSize?: string;
}) {
  const c = scheme.colors;
  const fg = c.foreground ?? "#ccc";

  return (
    <div
      // The sample's own edge, at 3:1 against the card: a terminal background one step
      // off the card (Daintree on its own settings card) otherwise dissolves into it,
      // and border-default is an ink at low alpha that measures about 1.05:1 there.
      className="rounded-[var(--radius-sm)] overflow-hidden border border-text-secondary"
      style={{
        backgroundColor: c.background ?? "#000",
        padding: "6px 8px",
        fontFamily,
        fontSize,
        lineHeight: "1.4",
        whiteSpace: "nowrap",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <div>
        <span style={{ color: c.green ?? fg }}>$ </span>
        <span style={{ color: fg }}>ls src/</span>
      </div>
      <div>
        <span style={{ color: c.cyan ?? fg }}>components/</span>
        <span style={{ color: fg }}> </span>
        <span style={{ color: c.cyan ?? fg }}>utils/</span>
        <span style={{ color: fg }}> index.ts</span>
      </div>
      <div>
        <span style={{ color: c.green ?? fg }}>$ </span>
        <span style={{ color: fg }}>git status</span>
      </div>
      <div>
        <span style={{ color: c.brightBlack ?? fg }}>modified: </span>
        <span style={{ color: c.yellow ?? fg }}>main.ts</span>
      </div>
      <div>
        <span style={{ color: c.green ?? fg }}>✓ </span>
        <span style={{ color: fg }}>3 tests passed</span>
      </div>
    </div>
  );
}

async function persistCustomSchemes() {
  const { customSchemes } = useTerminalColorSchemeStore.getState();
  await terminalConfigClient.setCustomSchemes(customSchemes);
}

// What is on disk, and which write is the newest. Module state because the selection
// lives in a global store and the picker can unmount mid-write; a failure only rolls
// back while it is still the latest intent, and only to a value that actually saved.
let confirmedSchemeId: string | null = null;
let schemeEpoch = 0;

/**
 * Select, persist, and put the selection back on failure. The MRU list rides along but
 * is invisible here, so only the scheme write itself is worth a banner.
 */
async function selectScheme(id: string, onError: (error: ColorSchemeError | null) => void) {
  const store = useTerminalColorSchemeStore.getState();
  confirmedSchemeId ??= store.selectedSchemeId;
  const epoch = ++schemeEpoch;
  onError(null);
  store.setSelectedSchemeId(id);
  store.setPreviewSchemeId(null);
  try {
    await terminalConfigClient.setColorScheme(id);
    confirmedSchemeId = id;
  } catch (error) {
    logError("Failed to persist color scheme", error);
    if (epoch !== schemeEpoch) return;
    useTerminalColorSchemeStore.getState().setSelectedSchemeId(confirmedSchemeId);
    onError({
      title: "Couldn't save color scheme",
      description: "The last saved scheme was restored, so it won't change on restart.",
      retry: () => void selectScheme(id, onError),
    });
    return;
  }
  try {
    await terminalConfigClient.setRecentSchemeIds(
      useTerminalColorSchemeStore.getState().recentSchemeIds
    );
  } catch (error) {
    logError("Failed to persist recent color schemes", error);
  }
}

/** Test seam: forget what the module believes is on disk. */
export function __resetSchemePersistenceForTests(): void {
  confirmedSchemeId = null;
  schemeEpoch = 0;
}

async function importScheme(onError: (error: ColorSchemeError | null) => void) {
  onError(null);
  try {
    const result = await terminalConfigClient.importColorScheme();
    if (!result.ok) {
      if (!result.errors.includes("Import cancelled")) {
        onError({
          title: "Couldn't import color scheme",
          description: result.errors[0] ?? "The file isn't a color scheme Daintree can read.",
          retry: () => void importScheme(onError),
        });
      }
      return;
    }

    const scheme: TerminalColorScheme = {
      ...result.scheme,
      builtin: false,
      colors: result.scheme.colors,
    };
    useTerminalColorSchemeStore.getState().addCustomScheme(scheme);
    await persistCustomSchemes();
    await selectScheme(scheme.id, onError);
  } catch (error) {
    logError("Failed to import color scheme", error);
    onError({
      title: "Couldn't import color scheme",
      description: "Something went wrong reading the file.",
      retry: () => void importScheme(onError),
    });
  }
}

/** The section's action: an imported scheme joins the list below and becomes the selection. */
export function ImportColorSchemeButton({
  onError,
}: {
  onError: (error: ColorSchemeError | null) => void;
}) {
  return (
    <Button variant="outline" size="sm" onClick={() => void importScheme(onError)}>
      Import color scheme…
    </Button>
  );
}

/**
 * "Match app theme" draws the current app theme's own terminal palette — the same
 * derivation the terminals use at runtime — so its card shows what selecting it will do
 * on this theme rather than the default theme's colors.
 */
export function resolveSchemeForPreview(
  scheme: TerminalColorScheme,
  appThemeId: string,
  appCustomSchemes: Parameters<typeof resolveAppTheme>[1] = []
): TerminalColorScheme {
  if (scheme.id !== DEFAULT_SCHEME_ID) return scheme;
  const appScheme = resolveAppTheme(appThemeId, appCustomSchemes);
  return { ...scheme, colors: getTerminalThemeFromAppScheme(appScheme) };
}

/**
 * Dark or light by what the terminal actually paints, not by the app theme a scheme
 * came from: Bondi is a light app theme with a deep-water terminal.
 */
export function schemeTone(scheme: TerminalColorScheme): Tone {
  const bg = scheme.colors.background;
  if (!bg || !/^#[0-9a-f]{6}$/i.test(bg)) return scheme.type === "light" ? "light" : "dark";
  return relativeLuminance(bg) > 0.2 ? "light" : "dark";
}

export function ColorSchemePicker({
  error,
  onError,
}: {
  error: ColorSchemeError | null;
  onError: (error: ColorSchemeError | null) => void;
}) {
  const selectedSchemeId = useTerminalColorSchemeStore((s) => s.selectedSchemeId);
  const customSchemes = useTerminalColorSchemeStore((s) => s.customSchemes);
  const setPreviewSchemeId = useTerminalColorSchemeStore((s) => s.setPreviewSchemeId);
  const appThemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const appCustomSchemes = useAppThemeStore((s) => s.customSchemes);

  const [previewAnnouncement, setPreviewAnnouncement] = useState("");

  const resolvedSchemes = useMemo(
    () =>
      [...BUILT_IN_SCHEMES, ...customSchemes].map((s) =>
        resolveSchemeForPreview(s, appThemeId, appCustomSchemes)
      ),
    [customSchemes, appThemeId, appCustomSchemes]
  );
  const selectedScheme =
    resolvedSchemes.find((s) => s.id === selectedSchemeId) ?? resolvedSchemes[0]!;

  const [tone, setTone] = useState<Tone>(() => schemeTone(selectedScheme));
  const visibleSchemes = useMemo(
    () => resolvedSchemes.filter((s) => schemeTone(s) === tone),
    [resolvedSchemes, tone]
  );

  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      setPreviewSchemeId(null);
    };
  }, [setPreviewSchemeId]);

  const handlePreviewItem = (id: string) => {
    setPreviewSchemeId(id);
    const scheme = resolvedSchemes.find((s) => s.id === id);
    if (scheme) setPreviewAnnouncement(`Previewing: ${scheme.name}`);
  };

  const handlePreviewEnd = () => {
    if (unmountedRef.current) return;
    setPreviewSchemeId(null);
    setPreviewAnnouncement("");
  };

  const isModified = selectedSchemeId !== DEFAULT_SCHEME_ID;

  return (
    <SettingsGroup>
      <SettingsRow
        id="appearance-color-scheme-list"
        label="Scheme"
        description={
          isModified
            ? `${selectedScheme.name} · Default: Match app theme`
            : "Match app theme, the app theme's own terminal colors"
        }
        isModified={isModified}
        onReset={() => void selectScheme(DEFAULT_SCHEME_ID, onError)}
        resetAriaLabel="Reset terminal color scheme to Match app theme"
      />
      {/* The collection is the group's body rather than a row: it has no label of its
          own to give, and a row around it would stretch the modified bar down its full
          height. The listbox takes its name from the Scheme row above. */}
      <div className="px-4 py-3">
        <ThemeSelector
          items={visibleSchemes}
          selectedId={selectedSchemeId}
          onSelect={(id) => void selectScheme(id, onError)}
          columns={3}
          getName={(s) => s.name}
          renderPreview={(s) => <SchemePreview scheme={s} />}
          onPreviewItem={handlePreviewItem}
          onPreviewEnd={handlePreviewEnd}
          previewAnnouncement={previewAnnouncement}
          listLabel="Terminal color schemes"
          searchPlaceholder="Filter schemes..."
          searchLabel="Filter color schemes"
          emptyMessage="No schemes match your search."
          toolbar={
            <SegmentedRadioGroup
              aria-label="Show dark or light schemes"
              options={TONE_OPTIONS}
              value={tone}
              onChange={setTone}
            />
          }
        />
      </div>
      {error && (
        <div className="px-4 py-3">
          <InlineStatusBanner
            className="rounded-[var(--radius-md)]"
            severity="error"
            title={error.title}
            description={error.description}
            action={{ id: "retry", label: "Retry", onClick: error.retry }}
            onClose={() => onError(null)}
            closeAriaLabel="Dismiss color scheme error"
          />
        </div>
      )}
    </SettingsGroup>
  );
}
