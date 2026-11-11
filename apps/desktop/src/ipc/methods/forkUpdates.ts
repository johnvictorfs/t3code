import { DesktopForkUpdateStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopForkUpdates from "../../updates/DesktopForkUpdates.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getForkUpdateState = makeIpcMethod({
  channel: IpcChannels.FORK_UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopForkUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.forkUpdate.getState")(function* () {
    return yield* (yield* DesktopForkUpdates.DesktopForkUpdates).state;
  }),
});

export const checkForkUpdate = makeIpcMethod({
  channel: IpcChannels.FORK_UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopForkUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.forkUpdate.check")(function* () {
    return yield* (yield* DesktopForkUpdates.DesktopForkUpdates).check;
  }),
});

export const startForkUpdate = makeIpcMethod({
  channel: IpcChannels.FORK_UPDATE_START_CHANNEL,
  payload: Schema.Void,
  result: DesktopForkUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.forkUpdate.start")(function* () {
    return yield* (yield* DesktopForkUpdates.DesktopForkUpdates).start;
  }),
});
