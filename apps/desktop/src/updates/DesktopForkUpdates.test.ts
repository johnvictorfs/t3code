import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopForkUpdates from "./DesktopForkUpdates.ts";

const fakeCheckScript = (result: { stdout: string; exitCode: number }) =>
  ChildProcessSpawner.make(() =>
    Effect.sync(() =>
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(result.stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

const forkUpdatesIn = (home: string, spawner = fakeCheckScript({ stdout: "", exitCode: 0 })) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* DesktopForkUpdates.make.pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        path,
        homeDirectory: home,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  });

const writeStateFile = (home: string, name: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(home, ".t3", "fork-update");
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, name), content);
  });

it.layer(NodeServices.layer)("DesktopForkUpdates", (it) => {
  it.effect("stays hidden until the update checkout is registered", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const forkUpdates = yield* forkUpdatesIn(yield* fs.makeTempDirectoryScoped());

      expect(yield* forkUpdates.state).toEqual({
        configured: false,
        pendingVersion: null,
        status: "idle",
        step: null,
      });
    }),
  );

  it.effect("reports the pending release, and keeps it when a later check fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* writeStateFile(home, "repo", "/work/t3code-fork");
      const script = { stdout: "v0.2.0\n", exitCode: 0 };
      const forkUpdates = yield* forkUpdatesIn(home, fakeCheckScript(script));

      expect((yield* forkUpdates.check).pendingVersion).toBe("v0.2.0");

      script.exitCode = 1;
      expect((yield* forkUpdates.check).pendingVersion).toBe("v0.2.0");

      script.exitCode = 0;
      script.stdout = "\n";
      expect((yield* forkUpdates.check).pendingVersion).toBeNull();
    }),
  );

  it.effect("reports a run whose script died as failed instead of running forever", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* writeStateFile(home, "repo", "/work/t3code-fork");
      const forkUpdates = yield* forkUpdatesIn(home);

      yield* writeStateFile(
        home,
        "status.json",
        JSON.stringify({ phase: "running", step: "Building the app", pid: process.pid }),
      );
      expect(yield* forkUpdates.state).toMatchObject({
        status: "running",
        step: "Building the app",
      });

      yield* writeStateFile(
        home,
        "status.json",
        JSON.stringify({ phase: "running", step: "Building the app", pid: 2 ** 22 + 1 }),
      );
      expect(yield* forkUpdates.state).toMatchObject({
        status: "failed",
        step: "Building the app",
      });
    }),
  );
});
