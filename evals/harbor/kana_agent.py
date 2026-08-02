import json
import re
import shlex
import tempfile
from pathlib import Path, PurePosixPath

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class KanaAgent(BaseInstalledAgent):
    """Run a locally built Kana binary as a Harbor installed agent."""

    _COMPONENT = "kana_harbor_adapter"
    _OUTPUT_FILENAME = "kana.jsonl"
    _STDERR_FILENAME = "kana.stderr"
    _REMOTE_BINARY = PurePosixPath("/installed-agent/kana")
    _REMOTE_HOME = PurePosixPath("/tmp/kana-home")
    _REMOTE_INSTRUCTION = PurePosixPath("/tmp/kana-instruction.txt")
    _MODEL_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")

    def __init__(self, *args, binary_path: str | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        configured_path = binary_path or self._get_env("KANA_EVAL_BINARY")
        self._binary_path = (
            Path(configured_path).expanduser().resolve()
            if configured_path
            else Path(__file__).resolve().parents[2] / "kana"
        )

    @staticmethod
    def name() -> str:
        return "kana"

    def get_version_command(self) -> str | None:
        return f"{self._REMOTE_BINARY} --version"

    async def install(self, environment: BaseEnvironment) -> None:
        self.logger.info(
            "kana_harbor.install_started",
            extra={
                "component": self._COMPONENT,
                "operation": "install",
                "outcome": "started",
            },
        )
        try:
            if not self._binary_path.is_file():
                raise FileNotFoundError(
                    f"Kana evaluation binary not found: {self._binary_path}. "
                    "Build it on the Harbor host or pass --ak binary_path=<path>."
                )
            await environment.upload_file(
                self._binary_path,
                self._REMOTE_BINARY.as_posix(),
            )
            result = await environment.exec(
                command=f"chmod 755 {self._REMOTE_BINARY}",
                user="root",
            )
            if result.return_code != 0:
                raise RuntimeError(
                    f"Failed to make the Kana binary executable (exit {result.return_code})."
                )
        except Exception as exc:
            self.logger.error(
                "kana_harbor.install_failed",
                extra={
                    "component": self._COMPONENT,
                    "operation": "install",
                    "outcome": "failed",
                    "error_type": type(exc).__name__,
                },
            )
            raise

        self.logger.info(
            "kana_harbor.install_completed",
            extra={
                "component": self._COMPONENT,
                "operation": "install",
                "outcome": "completed",
            },
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        output_path = self.logs_dir / self._OUTPUT_FILENAME
        if not output_path.is_file():
            return

        usage: dict[str, object] | None = None
        invalid_lines = 0
        try:
            with output_path.open(encoding="utf-8") as output:
                for line in output:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        invalid_lines += 1
                        continue

                    if not isinstance(event, dict):
                        invalid_lines += 1
                        continue
                    if event.get("type") == "run.completed" and isinstance(
                        event.get("usage"), dict
                    ):
                        usage = event["usage"]
        except OSError as exc:
            self.logger.warning(
                "kana_harbor.usage_read_failed",
                extra={
                    "component": self._COMPONENT,
                    "operation": "populate_context",
                    "outcome": "failed",
                    "error_type": type(exc).__name__,
                },
            )
            return

        if invalid_lines:
            self.logger.warning(
                "kana_harbor.invalid_jsonl",
                extra={
                    "component": self._COMPONENT,
                    "operation": "populate_context",
                    "outcome": "partial",
                    "invalid_line_count": invalid_lines,
                },
            )
        if usage is None:
            return

        context.n_input_tokens = self._read_token_count(usage, "input_tokens")
        context.n_output_tokens = self._read_token_count(usage, "output_tokens")
        context.n_cache_tokens = self._read_token_count(
            usage, "cache_read_input_tokens"
        )

    @staticmethod
    def _read_token_count(usage: dict[str, object], key: str) -> int | None:
        value = usage.get(key)
        return (
            value
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0
            else None
        )

    def _resolve_model(self) -> str:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError(
                "Model name must use the format deepseek/<model>, for example "
                "deepseek/deepseek-v4-pro."
            )

        provider, model = self.model_name.split("/", 1)
        if provider != "deepseek":
            raise ValueError(f"KanaAgent currently supports DeepSeek, not {provider}.")
        if not self._MODEL_PATTERN.fullmatch(model):
            raise ValueError(f"Invalid DeepSeek model name: {model!r}.")
        return model

    async def _upload_instruction(
        self, instruction: str, environment: BaseEnvironment
    ) -> None:
        # Staging the prompt avoids placing it in a shell command or diagnostic log.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as prompt_file:
            prompt_file.write(instruction)
            prompt_file.flush()
            await environment.upload_file(
                prompt_file.name,
                self._REMOTE_INSTRUCTION.as_posix(),
            )

        if environment.default_user is None:
            ownership_command = ""
        else:
            owner = shlex.quote(str(environment.default_user))
            ownership_command = f"chown {owner} {self._REMOTE_INSTRUCTION} && "

        result = await environment.exec(
            command=f"{ownership_command}chmod 600 {self._REMOTE_INSTRUCTION}",
            user="root",
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"Failed to prepare the Kana instruction file (exit {result.return_code})."
            )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context
        model = self._resolve_model()
        api_key = self._get_env("DEEPSEEK_API_KEY")
        if not api_key:
            raise ValueError(
                "DEEPSEEK_API_KEY is required. Export it before starting Harbor or "
                "pass it through Harbor's agent environment."
            )

        config = "\n".join(
            [
                '[provider]',
                'active = "deepseek"',
                '',
                '[model.deepseek]',
                f'name = "{model}"',
                'api_key_env = "DEEPSEEK_API_KEY"',
                '',
            ]
        )
        config_arg = shlex.quote(config)
        agent_dir = EnvironmentPaths.agent_dir.as_posix()
        output_path = (EnvironmentPaths.agent_dir / self._OUTPUT_FILENAME).as_posix()
        stderr_path = (EnvironmentPaths.agent_dir / self._STDERR_FILENAME).as_posix()
        env = {
            "DEEPSEEK_API_KEY": api_key,
            "KANA_HOME": self._REMOTE_HOME.as_posix(),
        }

        self.logger.info(
            "kana_harbor.run_started",
            extra={
                "component": self._COMPONENT,
                "operation": "run",
                "outcome": "started",
                "model": self.model_name,
            },
        )
        try:
            await self._upload_instruction(instruction, environment)
            command = (
                "set -o pipefail; "
                'install -d -m 700 "$KANA_HOME" && '
                f"printf '%s' {config_arg} > \"$KANA_HOME/config.toml\" && "
                'chmod 600 "$KANA_HOME/config.toml" && '
                f"mkdir -p {agent_dir} && "
                f"{self._REMOTE_BINARY} exec --clean --json --allow-all-tools "
                f"< {self._REMOTE_INSTRUCTION} 2> {stderr_path} | tee {output_path}"
            )
            result = await environment.exec(command=command, env=env)
            if result.return_code != 0:
                raise NonZeroAgentExitCodeError(
                    f"Kana exited with code {result.return_code}; see {stderr_path}."
                )
        except Exception as exc:
            self.logger.error(
                "kana_harbor.run_failed",
                extra={
                    "component": self._COMPONENT,
                    "operation": "run",
                    "outcome": "failed",
                    "error_type": type(exc).__name__,
                },
            )
            raise
        else:
            self.logger.info(
                "kana_harbor.run_completed",
                extra={
                    "component": self._COMPONENT,
                    "operation": "run",
                    "outcome": "completed",
                    "model": self.model_name,
                },
            )
        finally:
            try:
                await environment.exec(
                    command=f"rm -f {self._REMOTE_INSTRUCTION}",
                    user="root",
                )
            except Exception as exc:
                self.logger.warning(
                    "kana_harbor.instruction_cleanup_failed",
                    extra={
                        "component": self._COMPONENT,
                        "operation": "cleanup",
                        "outcome": "failed",
                        "error_type": type(exc).__name__,
                    },
                )
