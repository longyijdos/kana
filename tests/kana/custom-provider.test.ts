import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_KANA_CONFIG, getKanaConfigPaths, getKanaModelManagement } from "@/kana";
import {
  getKanaCustomProviderModel,
  parseKanaCustomProvider,
  resolveKanaCustomReasoning,
} from "../../src/kana/custom-provider";
import { createKanaModel } from "../../src/kana/model";
import { messageIdentityForTest } from "../helpers/messages";

const tempDirs: string[] = [];
const originalKanaHome = process.env.KANA_HOME;
const originalCustomKey = process.env.KANA_CUSTOM_TEST_KEY;

afterEach(() => {
  restoreEnv("KANA_HOME", originalKanaHome);
  restoreEnv("KANA_CUSTOM_TEST_KEY", originalCustomKey);
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana Custom provider", () => {
  test("parses the minimal provider definition with safe defaults", () => {
    expect(
      parseKanaCustomProvider({
        base_url: "http://127.0.0.1:8080/v1/",
        models: [
          {
            name: "local-model",
            context_window: 32_768,
            max_output_tokens: 4_096,
          },
        ],
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKeyEnv: undefined,
      timeoutMs: 60_000,
      maxRetries: 1,
      models: [
        {
          name: "local-model",
          metadata: {
            contextWindow: 32_768,
            maxOutputTokens: 4_096,
            supportsParallelToolCalls: false,
            supportsHostedWebSearch: false,
            supportsImageInput: false,
          },
        },
      ],
    });
  });

  test("parses private-network endpoints and model reasoning metadata", () => {
    const provider = parseKanaCustomProvider({
      base_url: "http://192.168.5.5:8080/v1",
      api_key_env: "LOCAL_MODEL_KEY",
      timeout_ms: 300_000,
      max_retries: 0,
      models: [
        {
          name: "reasoning-model",
          context_window: 32_768,
          max_output_tokens: 8_192,
          supports_parallel_tool_calls: true,
          supports_image_input: true,
          reasoning_efforts: ["none", "low", "high"],
          default_reasoning_effort: "low",
        },
      ],
    });
    const model = getKanaCustomProviderModel(provider, "reasoning-model");

    expect(provider).toMatchObject({
      baseUrl: "http://192.168.5.5:8080/v1",
      apiKeyEnv: "LOCAL_MODEL_KEY",
      timeoutMs: 300_000,
      maxRetries: 0,
    });
    expect(model.metadata).toMatchObject({
      contextWindow: 32_768,
      maxOutputTokens: 8_192,
      supportsParallelToolCalls: true,
      supportsImageInput: true,
      reasoning: { efforts: ["none", "low", "high"] },
    });
    expect(resolveKanaCustomReasoning(model)).toBe("low");
    expect(resolveKanaCustomReasoning(model, "high")).toBe("high");
    expect(() => resolveKanaCustomReasoning(model, "max")).toThrow(
      'Custom model "reasoning-model" reasoning_effort must be one of: none, low, high.',
    );
  });

  test("rejects unsafe endpoints and inconsistent model definitions", () => {
    const validModel = {
      name: "local-model",
      context_window: 8_192,
      max_output_tokens: 4_096,
    };
    const cases: Array<{ config: Record<string, unknown>; message: string }> = [
      {
        config: { base_url: "http://example.com/v1", models: [validModel] },
        message: "base_url must use HTTPS, except for HTTP loopback or private-network endpoints.",
      },
      {
        config: {
          base_url: "https://example.com/v1",
          api_key_env: "BAD-NAME",
          models: [validModel],
        },
        message: "api_key_env must be a valid environment variable name.",
      },
      {
        config: { base_url: "https://example.com/v1", models: [] },
        message: "custom provider models must contain at least one [[models]] table.",
      },
      {
        config: {
          base_url: "https://example.com/v1",
          models: [{ ...validModel, max_output_tokens: 16_384 }],
        },
        message: "models[0].max_output_tokens cannot exceed context_window.",
      },
      {
        config: {
          base_url: "https://example.com/v1",
          models: [
            {
              ...validModel,
              reasoning_efforts: ["none", "high"],
              default_reasoning_effort: "medium",
            },
          ],
        },
        message: "models[0].default_reasoning_effort must be listed in reasoning_efforts.",
      },
      {
        config: {
          base_url: "https://example.com/v1",
          models: [{ ...validModel, reasoning_efforts: ["off"] }],
        },
        message: 'models[0].reasoning_efforts uses "none" rather than "off"',
      },
    ];

    for (const { config, message } of cases) {
      expect(() => parseKanaCustomProvider(config)).toThrow(message);
    }
  });

  test("creates the static Custom model and sends configured reasoning", async () => {
    let authorization = "";
    let requestBody: Record<string, unknown> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        authorization = request.headers.get("authorization") ?? "";
        requestBody = (await request.json()) as Record<string, unknown>;
        return new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    try {
      const kanaHome = createTempDir();
      process.env.KANA_HOME = kanaHome;
      process.env.KANA_CUSTOM_TEST_KEY = "test-key";
      const paths = getKanaConfigPaths();
      mkdirSync(paths.providersDirectory, { recursive: true });
      writeFileSync(
        paths.customProviderPath,
        [
          `base_url = "http://127.0.0.1:${server.port}/v1"`,
          'api_key_env = "KANA_CUSTOM_TEST_KEY"',
          "max_retries = 0",
          "",
          "[[models]]",
          'name = "local-model"',
          "context_window = 32768",
          "max_output_tokens = 4096",
          'reasoning_efforts = ["none", "high"]',
          'default_reasoning_effort = "none"',
          "",
        ].join("\n"),
      );
      const config = structuredClone(DEFAULT_KANA_CONFIG);
      config.provider.active = "custom";
      config.model.custom = { name: "local-model", reasoningEffort: "high" };
      const management = getKanaModelManagement(config);
      const model = createKanaModel(config);

      expect(management.model.custom).toMatchObject({
        name: "local-model",
        reasoningEffort: "high",
        available: [
          {
            name: "local-model",
            reasoning: { efforts: ["none", "high"], defaultEffort: "none" },
          },
        ],
      });
      const message = await model.generate({
        messages: [{ ...messageIdentityForTest("user"), role: "user", content: "hello" }],
        maxOutputTokens: 512,
      });

      expect(model.metadata).toMatchObject({
        provider: "custom",
        model: "local-model",
        protocol: "chat-completions",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
      });
      expect(authorization).toBe("Bearer test-key");
      expect(requestBody).toMatchObject({
        model: "local-model",
        max_tokens: 512,
        reasoning_effort: "high",
      });
      expect(message).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "answer" }],
        usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
      });
    } finally {
      server.stop(true);
    }
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kana-custom-provider-"));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
