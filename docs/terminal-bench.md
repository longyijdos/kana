# Terminal-Bench 本地评测

Kana 通过 Harbor custom installed agent 接入 Terminal-Bench。适配器位于 `evals/harbor/kana_agent.py`：Harbor 在宿主机加载它，把已编译的 Kana Linux 二进制上传到任务容器，然后以无头模式执行一次完整 Agent run。该集成面向本地评测，不生成 ATIF；未显式传入 `--upload` 时，Harbor 只把结果保存在本地 jobs 目录。

## 准备环境

运行评测的机器需要：

- Docker daemon；
- Harbor 0.6.1；
- 与任务容器架构兼容的 Kana Linux 二进制；
- 可用的 `DEEPSEEK_API_KEY`。

Harbor 可以通过 uv tool 安装到独立环境，不需要在 Kana 仓库创建 Python `.venv`：

```bash
uv tool install harbor==0.6.1
```

在 Linux x64 宿主机上从源码构建默认二进制：

```bash
bun install --frozen-lockfile
bun run build:cli
./kana --version
```

适配器默认读取仓库根目录的 `./kana`。也可通过 agent kwarg 或宿主机环境变量指定其它路径：

```bash
--ak binary_path=/path/to/kana
```

```bash
export KANA_EVAL_BINARY=/path/to/kana
```

## 运行评测

先用单任务数据集验证完整链路：

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

再运行一个 Terminal-Bench 2.1 task：

```bash
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.harbor.kana_agent:KanaAgent \
  -m deepseek/deepseek-v4-pro \
  -l 1 \
  -n 1 \
  -k 1 \
  --agent-timeout-multiplier 3 \
  --verifier-timeout-multiplier 10 \
  --job-name kana-tb21-smoke \
  --jobs-dir ~/evals/kana/jobs
```

`-l` 限制 task 数，`-n` 控制并发 trial 数，`-k` 控制每个 task 的独立尝试次数。删除 `-l 1` 即可运行整个数据集；增加 `-n` 前应确认宿主机有足够的 CPU 和内存。

`--agent-timeout-multiplier` 和 `--verifier-timeout-multiplier` 分别只作用于 Agent 和 Verifier。以 Harbor 0.6.1 的默认 900 秒为基准，`--agent-timeout-multiplier 3` 给 Agent 约 45 分钟；Verifier 的 timeout multiplier 不会延长 Agent 的运行时间。

## 传入代理

如果任务容器需要通过代理访问模型、源码站点或包仓库，可以传入一个容器可访问的 HTTP proxy URL。Agent 和 Verifier 是两个独立阶段：

- `--ae KEY=VALUE` 把环境变量传给 Kana Agent；
- `--ve KEY=VALUE` 把环境变量传给 Verifier。

例如让两者使用同一个代理：

```bash
export EVAL_PROXY="http://proxy-host:8080"

harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.harbor.kana_agent:KanaAgent \
  -m deepseek/deepseek-v4-pro \
  -l 1 \
  -n 1 \
  -k 1 \
  --agent-timeout-multiplier 3 \
  --verifier-timeout-multiplier 10 \
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

适配器支持 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及其小写形式。若启动 Harbor 的进程已设置这些变量，Kana 会继承它们；显式传入的 `--ae` 值优先。代理地址必须能从任务容器访问，`localhost` 和 `127.0.0.1` 指向容器自身。

## 运行行为与结果

每个 trial 中，适配器会：

1. 上传 Kana 到 `/installed-agent/kana`；
2. 创建隔离的 `/tmp/kana-home` 并写入本次 DeepSeek model 配置；
3. 通过临时文件传入任务指令；
4. 执行 `kana exec --clean --json --allow-all-tools`；
5. 把 JSONL、stderr 和 token usage 交给 Harbor；
6. 删除临时指令文件。

`--clean` 会排除宿主机的 AGENTS、Skills、Memory 和 MCP 定制，并阻止 Kana 为 trial 写入 session journal、session log 与 accounting；`--allow-all-tools` 关闭交互审批，实际隔离边界由任务容器提供。Harbor 仍会保存适配器输出的 JSONL、stderr 与 token usage。每个 trial 的主要文件包括：

```text
agent/kana.jsonl
agent/kana.stderr
verifier/test-stdout.txt
verifier/test-stderr.txt
verifier/reward.txt
result.json
```

可以在本地启动结果浏览器：

```bash
harbor view ~/evals/kana/jobs --jobs
```

JSONL 可能包含任务指令、模型文本、工具参数和工具结果，应按敏感评测数据管理。
