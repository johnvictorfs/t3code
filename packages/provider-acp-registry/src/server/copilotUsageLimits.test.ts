import { expect, it } from "@effect/vitest";

import { copilotUserToLimits } from "./copilotUsageLimits.ts";

const checkedAt = "2026-11-11T19:53:29.434Z";

it("turns premium usage into a monthly window", () => {
  const limits = copilotUserToLimits(
    {
      quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
      quota_snapshots: { premium_interactions: { percent_remaining: 59.4, unlimited: false } },
    },
    checkedAt,
  );
  expect(limits.windows).toEqual([
    {
      id: "premiumInteractions",
      kind: "monthly",
      label: "Premium usage",
      usedPercent: 40.6,
      resetsAt: "2026-12-01T00:00:00.000Z",
    },
  ]);
});

it("reports no limit for unlimited plans and missing quotas", () => {
  const unlimited = copilotUserToLimits(
    { quota_snapshots: { premium_interactions: { percent_remaining: 100, unlimited: true } } },
    checkedAt,
  );
  expect(unlimited.windows).toEqual([]);
  expect(unlimited.unavailable?.reason).toBe("unsupported");
  expect(copilotUserToLimits({}, checkedAt).unavailable?.reason).toBe("unsupported");
});
