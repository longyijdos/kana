# Local Terminal-Bench evaluation

Kana integrates with Terminal-Bench through a Harbor custom installed agent. The adapter lives at `evals/harbor/kana_agent.py`: Harbor loads it on the host, uploads a compiled Kana Linux binary to the task container, and runs one complete headless Agent run. This integration targets local evaluation and does not generate ATIF. Unless `--upload` is explicitly supplied, Harbor stores results only in the local jobs directory.

## Prerequisites

The evaluation host needs:

- a Docker daemon;
- Harbor 0.6.1;
- a Kana Linux binary compatible with the task container architecture;
- a valid `DEEPSEEK_API_KEY`.

Harbor can be installed into an isolated uv tool environment; the Kana repository does not need a Python `.venv`:

```bash
uv tool install harbor==0.6.1
```

Build the default binary from source on a Linux x64 host:

```bash
bun install --frozen-lockfile
bun run build:cli
./kana --version
```

The adapter reads `./kana` from the repository root by default. An agent kwarg or host environment variable can select another path:

```bash
--ak binary_path=/path/to/kana
```

```bash
export KANA_EVAL_BINARY=/path/to/kana
```

## Running evaluations

Start with a single-task dataset to validate the complete path:

```bash
export DEEPSEEK_API_KEY="sk-..."

harbor run \
  -d harbor/hello-world \
  --agent-import-path evals.harbor.kana_agent:KanaAgent \
  -m deepseek/deepseek-v4-pro \
  -n 1 \
  -k 1 \
  --job-name kana-hello-world \
  --jobs-dir ~/evals/kana/jobs
```

Then run one Terminal-Bench 2.1 task:

```bash
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.harbor.kana_agent:KanaAgent \
  -m deepseek/deepseek-v4-pro \
  -l 1 \
  -n 1 \
  -k 1 \
  --job-name kana-tb21-smoke \
  --jobs-dir ~/evals/kana/jobs
```

`-l` limits the number of tasks, `-n` controls concurrent trials, and `-k` controls independent attempts per task. Remove `-l 1` to run the full dataset. Confirm that the host has sufficient CPU and memory before increasing `-n`.

## Passing a proxy

If task containers need a proxy to reach the model, source hosts, or package registries, pass an HTTP proxy URL that is reachable from the containers. The Agent and Verifier are separate phases:

- `--ae KEY=VALUE` passes an environment variable to the Kana Agent;
- `--ve KEY=VALUE` passes an environment variable to the Verifier.

For example, both phases can use the same proxy:

```bash
export EVAL_PROXY="http://proxy-host:8080"

harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.harbor.kana_agent:KanaAgent \
  -m deepseek/deepseek-v4-pro \
  -l 1 \
  -n 1 \
  -k 1 \
  --ae HTTP_PROXY="$EVAL_PROXY" \
  --ae HTTPS_PROXY="$EVAL_PROXY" \
  --ae http_proxy="$EVAL_PROXY" \
  --ae https_proxy="$EVAL_PROXY" \
  --ve HTTP_PROXY="$EVAL_PROXY" \
  --ve HTTPS_PROXY="$EVAL_PROXY" \
  --ve http_proxy="$EVAL_PROXY" \
  --ve https_proxy="$EVAL_PROXY" \
  --job-name kana-tb21-proxy-smoke \
  --jobs-dir ~/evals/kana/jobs
```

The adapter supports `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, and their lowercase forms. Kana inherits these variables when they are present in the process that starts Harbor; explicit `--ae` values take precedence. The proxy address must be reachable from the task container: `localhost` and `127.0.0.1` refer to the container itself.

## Runtime behavior and results

For each trial, the adapter:

1. uploads Kana to `/installed-agent/kana`;
2. creates an isolated `/tmp/kana-home` and writes the selected DeepSeek model configuration;
3. supplies the task instruction through a temporary file;
4. runs `kana exec --clean --json --allow-all-tools`;
5. exposes JSONL, stderr, and token usage to Harbor;
6. removes the temporary instruction file.

`--clean` excludes host AGENTS, Skills, Memory, and MCP customization. `--allow-all-tools` disables interactive approval, while the task container provides the actual isolation boundary. The primary per-trial files are:

```text
agent/kana.jsonl
agent/kana.stderr
verifier/test-stdout.txt
verifier/test-stderr.txt
verifier/reward.txt
result.json
```

Start the local result viewer with:

```bash
harbor view ~/evals/kana/jobs --jobs
```

JSONL may contain task instructions, model text, tool arguments, and tool results. Treat it as sensitive evaluation data.
