import type { ProviderInstanceId, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  type ProviderUsageSummary,
  remainingPercent,
  summarizeProviderUsage,
  totalUsageBudget,
} from "@t3tools/shared/usageLimits";
import { formatUsd } from "@t3tools/shared/usageFormat";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

type UsageLevel = "ok" | "low" | "critical";

const LOW_PERCENT = 50;
const CRITICAL_PERCENT = 20;

const LEVEL_TEXT_CLASS: Record<UsageLevel, string> = {
  ok: "text-success",
  low: "text-warning",
  critical: "text-destructive",
};

const LEVEL_BAR_CLASS: Record<UsageLevel, string> = {
  ok: "bg-success",
  low: "bg-warning",
  critical: "bg-destructive",
};

function usageLevel(window: ServerProviderUsageWindow): UsageLevel {
  const left = remainingPercent(window);
  if (left < CRITICAL_PERCENT) {
    return "critical";
  }
  if (left < LOW_PERCENT) {
    return "low";
  }
  return "ok";
}

function UsageBar({ window }: { readonly window: ServerProviderUsageWindow }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
      <div
        className={`h-full rounded-full ${LEVEL_BAR_CLASS[usageLevel(window)]}`}
        style={{ width: `${remainingPercent(window)}%` }}
      />
    </div>
  );
}

function ProviderUsageRow({ summary }: { readonly summary: ProviderUsageSummary }) {
  const { budget, window } = summary;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium">{summary.label}</span>
        {window ? (
          <span className={`shrink-0 tabular-nums ${LEVEL_TEXT_CLASS[usageLevel(window)]}`}>
            {remainingPercent(window)}% left
          </span>
        ) : (
          <span className="shrink-0 text-muted-foreground">No usage data</span>
        )}
      </div>
      {window ? <UsageBar window={window} /> : null}
      <span className="text-muted-foreground text-xs">
        {window ? window.label : summary.notice}
      </span>
      {budget ? (
        <div className="text-muted-foreground text-xs tabular-nums">
          {formatUsd(budget.usedUsd)} used of {formatUsd(budget.totalUsd)} ·{" "}
          {formatUsd(budget.leftUsd)} left
        </div>
      ) : null}
    </div>
  );
}

/** `$23.77 left · 9%`, with the percent colored by how little is left. */
function ChipLabel({ summary }: { readonly summary: ProviderUsageSummary }) {
  const { budget, window } = summary;
  if (!window) {
    return <span className="text-muted-foreground">--</span>;
  }
  return (
    <>
      {budget ? <span>{formatUsd(budget.leftUsd)} left</span> : null}
      {budget ? (
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
      ) : null}
      <span className={LEVEL_TEXT_CLASS[usageLevel(window)]}>{remainingPercent(window)}%</span>
    </>
  );
}

/** The provider's remaining quota beside the model picker. Opens every provider's quota and the dollar totals. */
export function ComposerUsageChip({
  entries,
  selectedInstanceId,
  budgetsUsd,
}: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly budgetsUsd: Readonly<Record<string, number | undefined>>;
}) {
  const summaries = summarizeProviderUsage(
    entries.map((entry) => entry.snapshot),
    budgetsUsd,
  );
  const selected = summaries.find((summary) => summary.instanceId === selectedInstanceId);
  if (!selected) {
    return null;
  }
  const total = totalUsageBudget(summaries);
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${selected.label} usage left`}
        render={
          <Badge
            variant="outline"
            size="control"
            className="min-w-12 tabular-nums"
            render={<button type="button" />}
          />
        }
      >
        <ChipLabel summary={selected} />
      </PopoverTrigger>
      <PopoverPopup align="start" side="top" width="sm">
        <div className="flex flex-col gap-3 text-foreground">
          <PopoverTitle>Usage left</PopoverTitle>
          {summaries.map((summary) => (
            <ProviderUsageRow key={summary.instanceId} summary={summary} />
          ))}
          {total ? (
            <div className="flex flex-col gap-0.5 border-t pt-2 text-sm tabular-nums">
              <div className="flex justify-between gap-3">
                <span className="font-medium">Total</span>
                <span>{total.leftPercent}% left</span>
              </div>
              <span className="text-muted-foreground text-xs">
                {formatUsd(total.usedUsd)} used of {formatUsd(total.totalUsd)} ·{" "}
                {formatUsd(total.leftUsd)} left
              </span>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
