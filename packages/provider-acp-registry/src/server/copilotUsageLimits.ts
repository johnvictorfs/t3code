import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// Not a documented API: it is what Copilot's own editor extensions read, so GitHub could change it.
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";

const CopilotUser = Schema.Struct({
  quota_reset_date_utc: Schema.optional(Schema.String),
  quota_snapshots: Schema.optional(
    Schema.Struct({
      premium_interactions: Schema.optional(
        Schema.Struct({
          percent_remaining: Schema.Number,
          unlimited: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
});

export function copilotUserToLimits(user: typeof CopilotUser.Type, checkedAt: string) {
  const premium = user.quota_snapshots?.premium_interactions;
  if (premium === undefined || premium.unlimited === true) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "This Copilot plan has no premium usage limit.",
    });
  }
  return makeUsageLimits({
    checkedAt,
    windows: [
      {
        id: "premiumInteractions",
        kind: "monthly",
        label: "Premium usage",
        usedPercent: clampPercent(100 - premium.percent_remaining),
        ...(user.quota_reset_date_utc ? { resetsAt: user.quota_reset_date_utc } : {}),
      },
    ],
  });
}

/** The token Copilot's own sign-in uses is not readable here, so this borrows the GitHub CLI's. */
const readGithubToken = Effect.fn("readGithubToken")(function* (environment: NodeJS.ProcessEnv) {
  return yield* Effect.gen(function* () {
    const fromEnvironment =
      environment.COPILOT_GITHUB_TOKEN?.trim() ||
      environment.GH_TOKEN?.trim() ||
      environment.GITHUB_TOKEN?.trim();
    if (fromEnvironment) return fromEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("gh", ["auth", "token"], {
            stdin: "ignore",
            stderr: "ignore",
            env: environment,
            extendEnv: true,
          }),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return exitCode === 0 ? stdout.trim() : "";
      }),
    ).pipe(Effect.orElseSucceed(() => ""));
  });
});

export const readCopilotUsageLimits = Effect.fn("readCopilotUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderUsageLimits,
  never,
  HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const token = yield* readGithubToken(environment);
  if (token === "") {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "Copilot usage needs a GitHub login. Run `gh auth login`, then refresh.",
    });
  }
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .execute(
      HttpClientRequest.get(COPILOT_USER_URL).pipe(
        HttpClientRequest.setHeaders({
          authorization: `token ${token}`,
          accept: "application/json",
          "user-agent": "GitHubCopilotChat/0.26.7",
          "editor-version": "vscode/1.99.0",
        }),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(CopilotUser)),
      Effect.timeout("10 seconds"),
      Effect.map((user) => copilotUserToLimits(user, checkedAt)),
      Effect.orElseSucceed(() =>
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Could not read Copilot usage from GitHub.",
        }),
      ),
    );
});
