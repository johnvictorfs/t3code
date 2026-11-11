import type { DesktopForkUpdateState } from "@t3tools/contracts";
import { DownloadIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const RUNNING_POLL_MS = 2_000;
const IDLE_CHECK_MS = 6 * 60 * 60 * 1_000;
const UPDATE_LOG_PATH = "~/.t3/fork-update/update.log";

function describeForkUpdate(state: DesktopForkUpdateState) {
  if (state.status === "running") {
    return {
      label: `${state.step ?? "Updating"}…`,
      description: "Updating your fork. T3 Code restarts when the new build is ready.",
    };
  }
  if (state.status === "failed") {
    return {
      label: "Update failed, retry",
      description: `Failed during: ${state.step ?? "an unknown step"}. The log is at ${UPDATE_LOG_PATH}.`,
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

/** Shows when upstream has a release this fork is not based on. One click rebases, rebuilds and restarts. */
export function SidebarForkUpdatePill() {
  const [state, setState] = useState<DesktopForkUpdateState | null>(null);
  const isRunning = state?.status === "running";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the update runs in a detached script, so its progress is only readable by polling the desktop main process
  useEffect(() => {
    const bridge = window.desktopBridge?.forkUpdate;
    if (!bridge) return;
    let cancelled = false;
    const refresh = () => {
      (isRunning ? bridge.getState() : bridge.check())
        .then((next) => {
          if (!cancelled) setState(next);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, isRunning ? RUNNING_POLL_MS : IDLE_CHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isRunning]);

  if (!isElectron || !state?.configured) return null;
  const isFailed = state.status === "failed";
  if (!isRunning && !isFailed && state.pendingVersion === null) return null;

  const handleClick = async () => {
    const bridge = window.desktopBridge?.forkUpdate;
    if (!bridge) return;
    try {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Update to ${state.pendingVersion ?? "the latest build"}?\n\nT3 Code rebases your fork onto it and rebuilds, which takes several minutes. It then restarts, and running agent turns stop.`,
      );
      if (!confirmed) return;
      setState(await bridge.start());
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start the update",
          description: error instanceof Error ? error.message : "The update did not start.",
        }),
      );
    }
  };

  const { label, description } = describeForkUpdate(state);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={isRunning}
            aria-label={description}
            className={`flex min-h-7 w-full shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-2xs leading-4 font-medium transition-colors disabled:cursor-default ${
              isFailed
                ? "bg-destructive/12 text-destructive enabled:hover:bg-destructive/18"
                : "bg-sidebar-control-surface text-sidebar-foreground enabled:hover:bg-sidebar-row-hover"
            }`}
            onClick={() => void handleClick()}
          >
            <ForkUpdateIcon status={state.status} />
            <span className="min-w-0 wrap-break-word">{label}</span>
          </button>
        }
      />
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}
