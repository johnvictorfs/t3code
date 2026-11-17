export const FORK_UPDATE_LOG_PATH = "~/.t3/fork-update/update.log";

/** The draft a failed fork update opens, written so a small model can finish it in few calls. */
export function buildForkUpdateFixPrompt(input: {
  readonly repo: string;
  readonly step: string | null;
  readonly pendingVersion: string | null;
}) {
  const step = input.step ?? "an unknown step";
  const isRebase = input.step?.startsWith("Rebasing") ?? false;
  return [
    `My fork's self-update failed during "${step}". Fix it in ${input.repo} (branch fork-main) and rebuild the app.${
      input.pendingVersion === null ? "" : ` The upstream release is ${input.pendingVersion}.`
    }`,
    "",
    "Keep this cheap. Every tool call and every file read costs money:",
    `- Read only the end of the log: \`tail -60 ${FORK_UPDATE_LOG_PATH}\`. Do not read the rest of it.`,
    "- Do not explore the codebase, use subagents, or read files the error does not name. Read only around the lines the error points at.",
    "- Do not run repo-wide checks. Typecheck only packages you changed (`vp run --filter <package> typecheck`) and run only test files next to your changes.",
    "- Batch shell commands where you can. Keep messages short. Do not ask me questions unless you are blocked.",
    "",
    "Steps:",
    ...(isRebase
      ? [
          `1. The script aborted the rebase. Run \`git rebase ${input.pendingVersion ?? "<newest v* tag>"}\` again in ${input.repo}.`,
          "2. For each conflict, keep upstream's code and re-apply the fork commit's addition on top. Then `git add` the file and run `GIT_EDITOR=true git rebase --continue`. Repeat until the rebase finishes.",
          "3. Typecheck the packages the conflicts touched, fix any break, and commit fixes with a conventional commit message.",
        ]
      : [
          "1. Find the cause in the log tail and make the smallest fix. Commit code fixes with a conventional commit message.",
          `2. If the error names \`.desktop-build.lock\`, check that no desktop build is running and \`git status\` is clean, then remove it.`,
        ]),
    `${isRebase ? 4 : 3}. Run \`zsh -lic 'bash scripts/fork-update.sh run --force --no-install'\` from ${input.repo} in the foreground, not in the background, and check that it exits 0. It takes a few minutes.`,
    "",
    "Do not run `scripts/fork-update.sh install` or `run` without `--no-install`. Installing quits T3 Code, which ends this thread. When the build is done, tell me in two or three sentences what you fixed, and to quit T3 Code and run `scripts/fork-update.sh install`.",
  ].join("\n");
}
