// @effect-diagnostics-next-line nodeBuiltinImport:off -- the Effect spawner kills its child when the scope closes, and the update has to outlive this app.
import * as NodeChildProcess from "node:child_process";

import type { DesktopForkUpdateState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const CHECK_TIMEOUT = Duration.seconds(60);

// `scripts/fork-update.sh` writes its progress to `status.json`, and `repo` names the checkout it runs from.
const ScriptStatus = Schema.Struct({
  phase: Schema.Literals(["idle", "running", "failed"]),
  step: Schema.optionalKey(Schema.String),
  pid: Schema.optionalKey(Schema.Number),
});
const decodeScriptStatus = Schema.decodeUnknownOption(Schema.fromJsonString(ScriptStatus));
const encodeScriptStatus = Schema.encodeEffect(Schema.fromJsonString(ScriptStatus));

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class DesktopForkUpdates extends Context.Service<
  DesktopForkUpdates,
  {
    readonly state: Effect.Effect<DesktopForkUpdateState>;
    /** Fetches upstream releases first, so it needs the network. */
    readonly check: Effect.Effect<DesktopForkUpdateState>;
    /** Runs the update detached: the script quits this app and relaunches it when the build is ready. */
    readonly start: Effect.Effect<DesktopForkUpdateState>;
  }
>()("@t3tools/desktop/updates/DesktopForkUpdates") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = environment.path;
  const stateDir = path.join(environment.homeDirectory, ".t3", "fork-update");
  const statusFile = path.join(stateDir, "status.json");
  const pendingVersion = yield* Ref.make<string | null>(null);

  const readText = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => null),
    );
  const readRepo = readText(path.join(stateDir, "repo"));
  const scriptPath = (repo: string) => path.join(repo, "scripts", "fork-update.sh");

  const readScriptStatus = Effect.gen(function* () {
    const raw = yield* readText(statusFile);
    const status = raw === null ? undefined : decodeScriptStatus(raw);
    if (status === undefined || status._tag === "None") {
      return { status: "idle", step: null } as const;
    }
    const { phase, step = null, pid } = status.value;
    if (phase === "failed") return { status: "failed", step } as const;
    if (phase === "idle") return { status: "idle", step: null } as const;
    // A run that died without writing a final status must not leave the pill spinning forever.
    return { status: pid !== undefined && isAlive(pid) ? "running" : "failed", step } as const;
  });

  const state = Effect.gen(function* () {
    if ((yield* readRepo) === null) {
      return { configured: false, pendingVersion: null, status: "idle", step: null } as const;
    }
    return {
      configured: true,
      pendingVersion: yield* Ref.get(pendingVersion),
      ...(yield* readScriptStatus),
    } as const;
  }).pipe(Effect.withSpan("DesktopForkUpdates.state"));

  const runCheck = (repo: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("/bin/bash", [scriptPath(repo), "check"], {
            cwd: repo,
            stdin: "ignore",
            stderr: "ignore",
          }),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return exitCode === 0 ? stdout.trim() : yield* Effect.fail(`check exited with ${exitCode}`);
      }),
    ).pipe(Effect.timeout(CHECK_TIMEOUT));

  const check = Effect.gen(function* () {
    const repo = yield* readRepo;
    if (repo !== null) {
      // A failed check (offline) keeps the last answer rather than hiding a pending update.
      const output = yield* runCheck(repo).pipe(Effect.option);
      if (output._tag === "Some") {
        yield* Ref.set(pendingVersion, output.value === "" ? null : output.value);
      }
    }
    return yield* state;
  }).pipe(Effect.withSpan("DesktopForkUpdates.check"));

  const start = Effect.gen(function* () {
    const repo = yield* readRepo;
    const current = yield* state;
    if (repo === null || current.status === "running") return current;

    // A login shell, because the packaged app's PATH has neither node nor pnpm.
    const child = NodeChildProcess.spawn(
      "/bin/zsh",
      ["-lic", 'exec bash "$0" run', scriptPath(repo)],
      { cwd: repo, detached: true, stdio: "ignore" },
    );
    // A failed spawn leaves no pid, which the status read above reports as a failed run.
    child.on("error", () => undefined);
    child.unref();
    if (child.pid !== undefined) {
      yield* encodeScriptStatus({ phase: "running", step: "Starting", pid: child.pid }).pipe(
        Effect.flatMap((json) =>
          fs
            .makeDirectory(stateDir, { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(statusFile, json))),
        ),
        Effect.ignore,
      );
    }
    return yield* state;
  }).pipe(Effect.withSpan("DesktopForkUpdates.start"));

  return DesktopForkUpdates.of({ state, check, start });
});

export const layer = Layer.effect(DesktopForkUpdates, make);
