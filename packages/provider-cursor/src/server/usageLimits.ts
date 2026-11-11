import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { CursorSettings } from "../settings.ts";
import { CURSOR_USAGE_WINDOWS } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  clampPercent,
  makeSpendUsageLimits,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { DEFAULT_CURSOR_API_ENDPOINT, exchangeCursorApiKey } from "./apiKey.ts";

const CursorSpendResponse = Schema.Struct({ totalCostCents: Schema.Number });
const CursorPlanInfoResponse = Schema.Struct({
  planInfo: Schema.optional(
    Schema.Struct({
      billingCycleEnd: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    }),
  ),
});

const CursorUsageResponse = Schema.Struct({
  billingCycleEnd: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  planUsage: Schema.optional(
    Schema.Struct({
      totalPercentUsed: Schema.optional(Schema.Number),
      autoPercentUsed: Schema.optional(Schema.Number),
      apiPercentUsed: Schema.optional(Schema.Number),
      // Team plans can report spend against a limit instead of percentages, both in cents.
      totalSpend: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
    }),
  ),
  spendLimitUsage: Schema.optional(
    Schema.Struct({
      individualLimit: Schema.optional(Schema.Number),
      individualUsed: Schema.optional(Schema.Number),
      pooledLimit: Schema.optional(Schema.Number),
      pooledUsed: Schema.optional(Schema.Number),
    }),
  ),
});

const decodeCursorUsage = Schema.decodeUnknownEffect(CursorUsageResponse);

function spendWindow(
  id: string,
  label: string,
  used: number | undefined,
  limit: number | undefined,
) {
  if (used === undefined || limit === undefined || !(limit > 0)) return undefined;
  return { id, label, usedPercent: clampPercent((used / limit) * 100) };
}

/** Cursor's dashboard percentages include bonus usage; spend / limit does not. */
export function cursorUsageResponseToLimits(
  response: typeof CursorUsageResponse.Type,
  checkedAt: string,
) {
  const reset = DateTime.make(Number(response.billingCycleEnd));
  const resetsAt =
    Number(response.billingCycleEnd) > 0 && Option.isSome(reset)
      ? DateTime.formatIso(reset.value)
      : undefined;
  const windows: ServerProviderUsageWindow[] = [];
  if (response.planUsage) {
    for (const { id, label } of CURSOR_USAGE_WINDOWS) {
      const usedPercent = response.planUsage[id];
      if (usedPercent === undefined || !Number.isFinite(usedPercent)) continue;
      windows.push({
        id,
        kind: "monthly",
        label,
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  if (windows.length === 0) {
    const spend = response.spendLimitUsage;
    const fallback =
      spendWindow(
        "planSpend",
        "Plan spend",
        response.planUsage?.totalSpend,
        response.planUsage?.limit,
      ) ??
      spendWindow(
        "individualLimit",
        "Your spend limit",
        spend?.individualUsed,
        spend?.individualLimit,
      ) ??
      spendWindow("pooledLimit", "Team spend limit", spend?.pooledUsed, spend?.pooledLimit);
    if (fallback) {
      windows.push({ ...fallback, kind: "monthly", ...(resetsAt ? { resetsAt } : {}) });
    }
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

/** Field names only, never values, so a plan Cursor reports differently can be told apart. */
function describeShape(value: unknown): string {
  if (typeof value !== "object" || value === null) return "nothing";
  const fields = Object.entries(value).flatMap(([key, child]) =>
    typeof child === "object" && child !== null && !Array.isArray(child)
      ? Object.keys(child).map((name) => `${key}.${name}`)
      : [key],
  );
  return fields.length > 0 ? fields.join(", ") : "an empty response";
}

export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (
  settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const endpoint = (
      settings.apiEndpoint?.trim() ||
      environment.CURSOR_API_ENDPOINT?.trim() ||
      DEFAULT_CURSOR_API_ENDPOINT
    ).replace(/\/$/, "");
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    const apiKey = environment.CURSOR_API_KEY?.trim();
    if (!token && apiKey) {
      if (endpoint !== DEFAULT_CURSOR_API_ENDPOINT) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Cursor usage for an API key requires the default Cursor endpoint.",
        });
      }
      token = yield* exchangeCursorApiKey(apiKey);
    }
    if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const client = yield* HttpClient.HttpClient;
    const dashboardRequest = (rpc: string) =>
      client.execute(
        HttpClientRequest.post(`${endpoint}/aiserver.v1.DashboardService/${rpc}`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeaders({
            "connect-protocol-version": "1",
            "x-cursor-client-type": "cli",
          }),
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      );
    const response = yield* dashboardRequest("GetCurrentPeriodUsage");
    const raw = yield* (yield* HttpClientResponse.filterStatusOk(response)).json;
    const body = yield* decodeCursorUsage(raw);
    const limits = cursorUsageResponseToLimits(body, checkedAt);
    if (limits.windows.length > 0) {
      return limits;
    }
    // Team plans hide the allowance from members, but the dashboard still adds up their spend.
    const spend = yield* dashboardRequest("GetAggregatedUsageEvents").pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(CursorSpendResponse)),
      Effect.option,
    );
    if (Option.isSome(spend)) {
      const plan = yield* dashboardRequest("GetPlanInfo").pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(CursorPlanInfoResponse)),
        Effect.option,
      );
      const cycleEnd = Option.getOrUndefined(plan)?.planInfo?.billingCycleEnd;
      const cycleEndDate = cycleEnd === undefined ? undefined : DateTime.make(Number(cycleEnd));
      return makeSpendUsageLimits({
        checkedAt,
        usd: spend.value.totalCostCents / 100,
        ...(cycleEndDate && Option.isSome(cycleEndDate)
          ? { resetsAt: DateTime.formatIso(cycleEndDate.value) }
          : {}),
      });
    }
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: `Cursor reported no usage limit for this account. It returned: ${describeShape(raw)}.`,
    });
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      }),
    ),
  );
});
