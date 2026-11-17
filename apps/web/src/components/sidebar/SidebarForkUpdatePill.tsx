import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationPlatform,
  type DesktopForkUpdateState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { DownloadIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useOpenLocalWorkspace } from "../../hooks/useOpenLocalWorkspace";
import { randomUUID } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildForkUpdateFixPrompt, FORK_UPDATE_LOG_PATH } from "./forkUpdateFixPrompt";

const RUNNING_POLL_MS = 2_000;
const IDLE_CHECK_MS = 60 * 60 * 1_000;
const FOCUS_CHECK_MIN_GAP_MS = 30 * 60 * 1_000;

const isActivationPlatform = Schema.is(DesktopAppActivationPlatform);

function describeForkUpdate(state: DesktopForkUpdateState) {
  if (state.status === "running") {
    return {
      label: `${state.step ?? "Updating"}…`,
      description: "Updating your fork. T3 Code restarts when the new build is ready.",
    };
  }
  if (state.status === "failed") {
    return {
      label: "Update failed, fix with an agent",
      description: `Failed during: ${state.step ?? "an unknown step"}. Opens a draft that asks an agent to fix and rebuild it. A low-cost model is enough. The log is at ${FORK_UPDATE_LOG_PATH}.`,
    };
  }
  return {
    label: `Update to ${state.pendingVersion}`,
    description: "Rebase your fork onto this release, rebuild the app and restart.",
  };
}

function ForkUpdateIcon({ status }: { readonly status: DesktopForkUpdateState["status"] }) {
  if (status === "running") {
    return <Spinner size="sm" className="shrink-0" />;
  }
  if (status === "failed") {
    return <TriangleAlertIcon className="size-3.5 shrink-0" />;
  }
  return <DownloadIcon className="size-3.5 shrink-0" />;
}

const showError = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

/** Shows when upstream has a release this fork is not based on. One click rebases, rebuilds and restarts. */
export function SidebarForkUpdatePill() {
  const [state, setState] = useState<DesktopForkUpdateState | null>(null);
  const openLocalWorkspace = useOpenLocalWorkspace();
  const isRunning = state?.status === "running";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the update runs in a detached script, so its progress is only readable by polling the desktop main process
  useEffect(() => {
    const bridge = window.desktopBridge?.forkUpdate;
    if (!bridge) return;
    let cancelled = false;
    let lastRefreshAt = 0;
    const refresh = () => {
      lastRefreshAt = Date.now();
      (isRunning ? bridge.getState() : bridge.check())
        .then((next) => {
          if (!cancelled) setState(next);
        })
        .catch(() => undefined);
    };
    // Timers stop while the Mac sleeps, so an app left open for days would rarely reach the interval.
    const refreshOnFocus = () => {
      if (Date.now() - lastRefreshAt >= FOCUS_CHECK_MIN_GAP_MS) refresh();
    };
    refresh();
    const timer = setInterval(refresh, isRunning ? RUNNING_POLL_MS : IDLE_CHECK_MS);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [isRunning]);

  if (!isElectron || state === null || state.repo === null) return null;
  const repo = state.repo;
  const isFailed = state.status === "failed";
  if (!isRunning && !isFailed && state.pendingVersion === null) return null;

  const startUpdate = async () => {
    const bridge = window.desktopBridge?.forkUpdate;
    if (!bridge) return;
    try {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Update to ${state.pendingVersion ?? "the latest build"}?\n\nT3 Code rebases your fork onto it and rebuilds, which takes several minutes. It then restarts, and running agent turns stop.`,
      );
      if (!confirmed) return;
      setState(await bridge.start());
    } catch (error) {
      showError(
        "Could not start the update",
        error instanceof Error ? error.message : "The update did not start.",
      );
    }
  };

  const openFixDraft = async () => {
    const platform = window.desktopBridge?.getClientPlatform();
    if (!openLocalWorkspace.ready || platform === undefined || !isActivationPlatform(platform)) {
      showError("Could not open the fix draft", "This computer's server is not connected yet.");
      return;
    }
    const response = await openLocalWorkspace
      .open(
        {
          version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
          requestId: randomUUID(),
          type: "open-workspace",
          workspaceRoot: repo,
          platform,
        },
        { envMode: "local", prompt: buildForkUpdateFixPrompt({ ...state, repo }) },
      )
      .catch(() => ({ ok: false as const, message: "T3 Code could not open a new thread." }));
    if (!response.ok) showError("Could not open the fix draft", response.message);
  };

  const { label, description } = describeForkUpdate(state);

  return (
    <div className="flex w-full shrink-0 items-stretch gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={isRunning}
              aria-label={description}
              className={`flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-2xs leading-4 font-medium transition-colors disabled:cursor-default ${
                isFailed
                  ? "bg-destructive/12 text-destructive enabled:hover:bg-destructive/18"
                  : "bg-sidebar-control-surface text-sidebar-foreground enabled:hover:bg-sidebar-row-hover"
              }`}
              onClick={() => void (isFailed ? openFixDraft() : startUpdate())}
            >
              <ForkUpdateIcon status={state.status} />
              <span className="min-w-0 wrap-break-word">{label}</span>
            </button>
          }
        />
        <TooltipPopup side="top">{description}</TooltipPopup>
      </Tooltip>
      {isFailed ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Retry the update"
                className="flex shrink-0 items-center rounded-lg bg-destructive/12 px-2 text-destructive transition-colors hover:bg-destructive/18"
                onClick={() => void startUpdate()}
              >
                <RotateCwIcon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="top">Retry the update without changes</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
