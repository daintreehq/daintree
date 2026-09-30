import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { PLUGIN_PERF_BUDGETS, type PluginPerfBudgetKey } from "@shared/config/pluginBudgets";
import type { PluginPerfSnapshot, PluginViewLoadSample } from "@shared/types/pluginMetrics";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { formatBytes } from "@/lib/formatBytes";
import { pluralize } from "@/lib/pluralize";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { usePluginStyleReport } from "@/hooks/usePluginStyleReport";

/** Read once at module scope: a member expression in a default parameter bails React Compiler. */
const DEVELOPMENT_BUILD = import.meta.env.DEV;

/** Measurements are milliseconds long, so they keep the shared formatter's sub-second precision. */
const measured = (ms: number): string => formatElapsedDuration(ms, { subSecond: true });

function formatRate(perSecond: number): string {
  return perSecond < 10 ? perSecond.toFixed(1) : String(Math.round(perSecond));
}

/**
 * What the view waited on before it could render: activation, then the longer
 * of the module import and style preparation, which run side by side. The same
 * figure main compares against `viewLoadMs`.
 */
function viewLoadMsOf(sample: PluginViewLoadSample): number {
  return sample.activateMs + Math.max(sample.importMs, sample.stylesMs);
}

interface MetricRowProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  budget?: string;
  /** Main reports the measurement above this budget. */
  aboveBudget?: boolean;
  /** A second budget on the same row, with its own marker. */
  secondBudget?: { text: string; above: boolean };
}

function BudgetLine({ text, above }: { text: string; above: boolean }) {
  return (
    <div className="text-2xs text-text-secondary mt-0.5 tabular-nums">
      {text}
      {above && <span className="text-text-primary font-medium"> · above</span>}
    </div>
  );
}

/**
 * One measurement beside its budget. Going over is stated in words, at text
 * weight, and never in a status colour: the number is an observation for the
 * reader to weigh, not a fault the app has diagnosed.
 */
function MetricRow({
  label,
  value,
  detail,
  budget,
  aboveBudget = false,
  secondBudget,
}: MetricRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="min-w-0">
        <div className="text-xs text-text-primary">{label}</div>
        {detail && <div className="text-2xs text-text-secondary mt-0.5 break-words">{detail}</div>}
      </dt>
      <dd className="text-right shrink-0">
        <div className="text-xs text-text-primary tabular-nums">{value}</div>
        {budget && <BudgetLine text={budget} above={aboveBudget} />}
        {secondBudget && <BudgetLine text={secondBudget.text} above={secondBudget.above} />}
      </dd>
    </div>
  );
}

function over(snapshot: PluginPerfSnapshot, ...keys: PluginPerfBudgetKey[]): boolean {
  return keys.some((key) => snapshot.overBudget.includes(key));
}

/**
 * The plugin's cost as main has measured it this session. Everything here is a
 * reading, shown beside the budget it is compared with; nothing is ranked,
 * graded or acted on.
 */
export function PluginPerformanceSection({
  snapshot,
  developmentBuild = DEVELOPMENT_BUILD,
}: {
  snapshot: PluginPerfSnapshot;
  /** Whether this renderer runs React's Profiler callbacks. A seam for tests. */
  developmentBuild?: boolean;
}) {
  const budgets = PLUGIN_PERF_BUDGETS;
  const latestLoad = snapshot.viewLoads[snapshot.viewLoads.length - 1];
  const { invokes, pushes, longFrames, activation, viewCommits } = snapshot;

  const invokeExtras = [
    invokes.errors > 0 ? pluralize(invokes.errors, "error") : null,
    invokes.timeouts > 0 ? `${invokes.timeouts.toLocaleString()} timed out` : null,
    invokes.oversized > 0 ? `${invokes.oversized.toLocaleString()} oversized` : null,
  ].filter((part): part is string => part !== null);

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-secondary">
        Measured since <TimeAgo timestamp={snapshot.since} verbose />, in this session only. These
        are observations, not a verdict: a plugin that was active during a slow frame didn&rsquo;t
        necessarily cause it. Budgets are guides, and Daintree never slows or stops a plugin for
        going over one.
      </p>

      <dl className="divide-y divide-border-subtle">
        <MetricRow
          label="Activation"
          value={activation ? measured(activation.lastMs) : "Not activated yet"}
          detail={
            activation && activation.count > 1
              ? `Last of ${pluralize(activation.count, "activation")}`
              : undefined
          }
          budget={`Budget ${measured(budgets.activationMs)}`}
          aboveBudget={over(snapshot, "activationMs")}
        />

        <MetricRow
          label="Last view load"
          value={latestLoad ? measured(viewLoadMsOf(latestLoad)) : "No view opened yet"}
          detail={
            latestLoad
              ? `Activate ${measured(latestLoad.activateMs)} · import ${measured(
                  latestLoad.importMs
                )} · styles ${measured(latestLoad.stylesMs)}${
                  latestLoad.retry ? " · after a retry" : ""
                }`
              : undefined
          }
          budget={`Budget ${measured(budgets.viewLoadMs)}`}
          aboveBudget={over(snapshot, "viewLoadMs")}
        />

        {latestLoad && (
          <MetricRow
            label="Last view first paint"
            value={measured(latestLoad.firstPaintMs)}
            detail="From opening the view to its first painted frame"
            budget={`Budget ${measured(budgets.viewFirstPaintMs)}`}
            aboveBudget={over(snapshot, "viewFirstPaintMs")}
          />
        )}

        <MetricRow
          label="View render time"
          value={
            viewCommits
              ? `p95 ${measured(viewCommits.p95Ms)}`
              : developmentBuild
                ? "None observed yet"
                : "Not measured"
          }
          detail={
            viewCommits
              ? `${pluralize(viewCommits.count, "commit")} · p50 ${measured(
                  viewCommits.p50Ms
                )} · max ${measured(viewCommits.maxMs)}`
              : developmentBuild
                ? undefined
                : "Only measured in development builds"
          }
          budget={`Budget p95 ${measured(budgets.viewCommitP95Ms)}`}
          aboveBudget={over(snapshot, "viewCommitP95Ms")}
        />

        <MetricRow
          label="Calls to the plugin"
          value={invokes.count > 0 ? `p95 ${measured(invokes.p95Ms)}` : "None yet"}
          detail={
            invokes.count > 0
              ? [
                  pluralize(invokes.count, "call"),
                  `p50 ${measured(invokes.p50Ms)}`,
                  `max ${measured(invokes.maxMs)}`,
                  ...invokeExtras,
                ].join(" · ")
              : undefined
          }
          budget={`Budget p95 ${measured(budgets.invokeP95Ms)}`}
          aboveBudget={over(snapshot, "invokeP95Ms")}
        />

        <MetricRow
          label="Messages to views"
          value={
            pushes.messages > 0
              ? `${formatRate(pushes.perSecond)}/s · ${formatBytes(pushes.bytesPerSecond)}/s`
              : "None yet"
          }
          detail={
            pushes.messages > 0
              ? [
                  `${pluralize(pushes.messages, "message")} · ${formatBytes(pushes.bytes)} in total`,
                  ...(pushes.oversized > 0
                    ? [`${pushes.oversized.toLocaleString()} oversized`]
                    : []),
                ].join(" · ")
              : undefined
          }
          budget={`Budget ${budgets.pushesPerSecond}/s`}
          aboveBudget={over(snapshot, "pushesPerSecond")}
          secondBudget={{
            text: `Budget ${formatBytes(budgets.pushBytesPerSecond)}/s`,
            above: over(snapshot, "pushBytesPerSecond"),
          }}
        />

        <MetricRow
          label="Long frames with plugin activity"
          value={longFrames.count > 0 ? pluralize(longFrames.count, "frame") : "None observed"}
          detail={
            longFrames.count > 0 ? (
              <>
                {measured(longFrames.totalBlockingMs)} blocking in total
                {longFrames.lastAt !== null && (
                  <>
                    {" · last "}
                    <TimeAgo timestamp={longFrames.lastAt} verbose />
                  </>
                )}
                {" · the plugin was active during these frames"}
              </>
            ) : (
              "Slow frames during which this plugin's view rendered or its code ran"
            )
          }
        />

        {snapshot.isolation === "worker" && (
          <MetricRow
            label="Worker memory"
            value={
              snapshot.workerMemory
                ? formatBytes(snapshot.workerMemory.rssBytes)
                : "Not sampled yet"
            }
            detail={
              snapshot.workerMemory ? (
                <TimeAgo timestamp={snapshot.workerMemory.at} verbose prefix="Sampled " />
              ) : undefined
            }
            budget={`Budget ${formatBytes(budgets.workerRssBytes)}`}
            aboveBudget={over(snapshot, "workerRssBytes")}
          />
        )}
      </dl>
    </div>
  );
}

const STOCK_PALETTE_PATTERN =
  /(?:^|[:!-])(?:bg|text|border|border-[trblxyse]|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|shadow|placeholder|inset-shadow|inset-ring)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/[\w.[\]%]+)?$/;

/** Splits "no CSS" classes into the one cause worth naming and everything else. */
export function groupNotGenerated(classes: readonly string[]): {
  stockPalette: string[];
  other: string[];
} {
  const stockPalette: string[] = [];
  const other: string[] = [];
  for (const name of [...classes].sort()) {
    (STOCK_PALETTE_PATTERN.test(name) ? stockPalette : other).push(name);
  }
  return { stockPalette, other };
}

function ClassList({ classes }: { classes: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {classes.map((name) => (
        <li
          key={name}
          className="font-mono text-2xs text-text-primary bg-overlay-subtle rounded-[var(--radius-sm)] px-1.5 py-0.5 select-text break-all"
        >
          {name}
        </li>
      ))}
    </ul>
  );
}

/**
 * Classes in the plugin's open views that compile to nothing against
 * Daintree's styling contract — a stock Tailwind colour, a typo, a utility
 * from another Tailwind version. Reads the live DOM of this window, so it can
 * only report on views that are open here.
 */
export function PluginStylesSection({ pluginId }: { pluginId: string }) {
  const { state, recheck } = usePluginStyleReport(pluginId);
  const checking = state.status === "checking";
  const showChecking = useDeferredLoading(checking, UI_DOHERTY_THRESHOLD);

  let body: ReactNode;
  if (state.status === "checking") {
    body = showChecking ? <p className="text-xs text-text-secondary">Checking styles…</p> : null;
  } else if (state.status === "error") {
    body = (
      <Callout severity="error" size="compact">
        <p>{state.message}</p>
      </Callout>
    );
  } else if (state.status === "no-views") {
    body = (
      <p className="text-xs text-text-secondary">
        Open one of this plugin&rsquo;s panels to check its styles.
      </p>
    );
  } else {
    const { stockPalette, other } = groupNotGenerated(state.report.notGenerated);
    const total = state.report.generated.length + state.report.notGenerated.length;
    body =
      state.report.notGenerated.length === 0 ? (
        <p className="text-xs text-text-secondary">
          Every class in this plugin&rsquo;s open panels matches a Daintree plugin utility (
          {pluralize(total, "class", "classes")} checked).
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-text-secondary">
            {pluralize(state.report.notGenerated.length, "class", "classes")} of {total} in this
            plugin&rsquo;s open panels produced no CSS.
          </p>
          {stockPalette.length > 0 && (
            <div className="space-y-2">
              <h4 className={SECTION_LABEL_CLASS}>Stock Tailwind colours</h4>
              <p className="text-2xs text-text-secondary">
                Daintree&rsquo;s plugin styles don&rsquo;t include Tailwind&rsquo;s default palette.
                Use a theme colour such as <code>text-text-secondary</code> or{" "}
                <code>bg-surface-panel</code> so the view follows the user&rsquo;s theme.
              </p>
              <ClassList classes={stockPalette} />
            </div>
          )}
          {other.length > 0 && (
            <div className="space-y-2">
              <h4 className={SECTION_LABEL_CLASS}>No matching utility</h4>
              <p className="text-2xs text-text-secondary">
                Often a typo or a utility from a different Tailwind version. Class names the plugin
                styles with its own CSS show up here too.
              </p>
              <ClassList classes={other} />
            </div>
          )}
        </div>
      );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-text-secondary">
          Classes in this plugin&rsquo;s open panels that Daintree&rsquo;s plugin styles generate no
          CSS for. Popups a panel opens outside itself aren&rsquo;t included.
        </p>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            if (!checking) recheck();
          }}
          aria-busy={checking || undefined}
          aria-disabled={checking || undefined}
          className="shrink-0"
        >
          <SpinningIcon icon={RefreshCw} active={checking} />
          Check again
        </Button>
      </div>
      {body}
    </div>
  );
}
