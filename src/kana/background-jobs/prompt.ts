import type { PromptContextSection, PromptContextState, PromptSystemSection } from "@/agent";
import type { BackgroundJobClient } from "@/jobs";

export function createBackgroundJobPromptSections(jobs: BackgroundJobClient): {
  system: PromptSystemSection;
  context: PromptContextSection;
} {
  return {
    system: {
      name: "background-jobs:guidance",
      content: [
        "Use bash with background=true when a command must outlive its initiating tool call.",
        "Do not use raw shell backgrounding to escape Kana ownership.",
        "Use job_output to consume bounded unseen output, optionally waiting for new output or completion; use job_kill to stop work that is no longer needed.",
        "Do not repeatedly poll a running Job when no new output is expected.",
      ].join(" "),
    },
    context: {
      name: "background-jobs",
      render: () => formatBackgroundJobContext(jobs),
    },
  };
}

function formatBackgroundJobContext(jobs: BackgroundJobClient): PromptContextState {
  const visible = jobs.context();
  if (visible.length === 0) {
    return {
      status: "inactive",
      content: "The current session has no active or unreported Background Jobs.",
    };
  }
  return {
    status: "active",
    content: [
      "Authoritative process-local Background Job state for the current session.",
      JSON.stringify({
        jobs: visible.map((job) => ({
          id: job.id,
          kind: job.kind,
          label: job.label,
          cwd: job.cwd,
          status: job.status,
          exitCode: job.exitCode,
        })),
      }),
    ].join("\n"),
  };
}
