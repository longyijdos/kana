# Kana Agent reusable workflow

Kana publishes the issue and pull-request automation in
`.github/workflows/kana-agent-reusable.yml`. A caller repository keeps only a small
`issue_comment` workflow plus its Kana configuration. The called workflow checks out and
publishes to the caller repository, while runtime binaries always come from the public
`longyijdos/kana` releases.

## Minimal caller

Create `.github/workflows/kana-agent.yml` in the caller repository and replace
`<release-tag>` with a published Kana tag:

```yaml
name: Kana Agent

on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  issues: read
  pull-requests: read

jobs:
  kana:
    uses: longyijdos/kana/.github/workflows/kana-agent-reusable.yml@<release-tag>
    with:
      config-path: .github/kana/config.toml
      kana-version: <release-tag>
    secrets:
      KANA_GITHUB_TOKEN: ${{ secrets.KANA_GITHUB_TOKEN }}
      KANA_MODEL_API_KEY: ${{ secrets.KANA_MODEL_API_KEY }}
```

`KANA_GITHUB_TOKEN` is required. It identifies the Kana account, reads Kana's public
release metadata and assets across the repository boundary, and publishes branches, draft
pull requests, and comments. Give that token read/write access to Contents, Issues, and
Pull requests in the caller repository. It also needs permission to update workflow files
if Kana is expected to publish such changes.

`KANA_MODEL_API_KEY` is required only when the selected provider needs a bearer/API key.
It is exposed to Kana under that provider-neutral environment-variable name and is
redacted from handoff and failure text before publication. The selected provider config
must name `KANA_MODEL_API_KEY`; do not put the credential itself in TOML.

The caller repository may also need to allow actions and reusable workflows from the
public `longyijdos/kana` repository in its Actions settings.

## Repository-local configuration

The required `config-path` selects the repository's normal Kana `config.toml`. For the
built-in DeepSeek provider, a workflow configuration can be:

```toml
# .github/kana/config.toml
[provider.deepseek]
api_key_env = "KANA_MODEL_API_KEY"

[agent]
goal_max_rounds = 3

[agent.model]
provider = "deepseek"
name = "deepseek-v4-flash"
reasoning_effort = "max"

[memory]
enabled = false

[notification]
backend = "off"
on_agent_completed = false
on_approval_required = false
```

Model selection remains entirely in Kana's existing configuration schema. See
[Configuration and installation](configuration.md) for all built-in provider, Agent, and
runtime settings.

To use a Custom OpenAI-compatible endpoint, select `custom` in `config.toml`:

```toml
# .github/kana/config.toml
[agent]
goal_max_rounds = 3

[agent.model]
provider = "custom"
name = "coding-plan-model"

[memory]
enabled = false
```

Add the provider definition separately:

```toml
# .github/kana/providers/custom.toml
base_url = "https://models.example.com/v1"
api_key_env = "KANA_MODEL_API_KEY"

[[models]]
name = "coding-plan-model"
context_window = 131072
max_output_tokens = 32768
supports_parallel_tool_calls = true
```

Then pass it from the caller:

```yaml
with:
  config-path: .github/kana/config.toml
  custom-provider-path: .github/kana/providers/custom.toml
  kana-version: <release-tag>
```

The complete provider schema and endpoint trust boundary are documented in
[Custom OpenAI-compatible provider](custom-provider.md).

At runtime, the workflow copies the selected files from the caller commit that triggered
the workflow into `$RUNNER_TEMP/kana-home` and exports that directory as `KANA_HOME`.
Sessions, logs, usage, and other mutable state therefore do not pollute the checkout. PR
follow-ups cannot replace trusted configuration on their Kana-authored working branch;
configuration continues to come from the triggering default-branch commit.

## Repository setup and preflight

The reusable workflow does not assume a language, package manager, or dependency
installer. If the repository needs preparation, commit a script such as:

```bash
#!/usr/bin/env bash
set -euo pipefail

npm ci
```

Pass it with `setup-script-path: .github/kana/setup.sh`. The workflow loads the script
from the same trusted caller commit as the configuration and runs it from the checked-out
repository before Kana starts. Omit the input when no setup is required. A setup failure
is reported as a warning and Kana still runs so it can inspect and repair the checkout.

`preflight-command` optionally runs a repository-specific formatting and validation
command after Kana produces changes. It is omitted by default; without it, Kana's own
checks still run as directed by the task prompt, and the published summary reports that
workflow preflight was not configured.

## Inputs and authorization

| Input | Default | Contract |
| --- | --- | --- |
| `config-path` | Required | Repository-relative `config.toml` path. |
| `custom-provider-path` | Empty | Repository-relative `providers/custom.toml` path. |
| `setup-script-path` | Empty | Repository-relative setup script run before Kana. |
| `preflight-command` | Empty | Repository-specific command run after a changed Agent run. |
| `kana-version` | `latest` | Release tag downloaded from `longyijdos/kana`, or the latest stable release. |
| `authorized-maintainer` | Caller repository owner | GitHub login allowed to invoke the workflow. |

Only a comment authored by the authorized maintainer can start work. On an issue, that
maintainer can use `@<kana-account> fix` regardless of who opened the issue. On a pull
request, follow-up remains restricted to an open PR authored by the Kana account, hosted
in the caller repository, and using a `kana/issue-<number>-<run-id>` branch. Set
`authorized-maintainer` when the appropriate maintainer login differs from the repository
owner, which is common for organization-owned repositories.

The Kana account is resolved from `KANA_GITHUB_TOKEN`, so commands must mention that
account's login. The reusable workflow retains the existing Goal execution, structured
result parsing, partial-progress publication, draft PR creation, and follow-up behavior.
The Agent supplies one `PR_TITLE` for the commit and pull request. The workflow enforces
only a non-empty, single-line, 120-character limit and leaves naming conventions to the
caller repository's instructions.

## Version pinning and updates

The reusable workflow reference and the downloaded runtime are separate pins. For a
fully reproducible integration, set both `uses: ...@vX.Y.Z` and
`kana-version: vX.Y.Z`. Update both values together after reviewing a new Kana release.
Leaving `kana-version` at `latest` keeps the workflow implementation pinned while allowing
the runtime binary to advance independently. A commit SHA is also valid in `uses` when a
repository requires an immutable workflow reference; `kana-version` still takes a
published release tag.
