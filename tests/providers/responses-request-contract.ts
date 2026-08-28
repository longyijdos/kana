import { describe, expect, test } from "bun:test";
import type { ModelContext } from "../../src/core";
import { messageIdentityForTest } from "../helpers/messages";

type BuildResponsesRequest = (context: ModelContext) => Record<string, unknown>;

export function responsesRequestContract(label: string, buildRequest: BuildResponsesRequest): void {
  describe(label, () => {
    test("encodes enabled and disabled user image attachments", () => {
      const context: ModelContext = {
        messages: [
          {
            ...messageIdentityForTest("user"),
            role: "user",
            content: "Inspect this.",
            images: [
              {
                mimeType: "image/jpeg",
                data: "private-image-bytes",
                width: 32,
                height: 16,
              },
            ],
          },
        ],
      };

      const enabled = buildRequest({ ...context, imageInput: true });
      const disabled = buildRequest({ ...context, imageInput: false });

      expect(enabled.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Inspect this." },
            {
              type: "input_image",
              image_url: "data:image/jpeg;base64,private-image-bytes",
            },
          ],
        },
      ]);
      expect(disabled.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Inspect this." },
            {
              type: "input_text",
              text: "[1 image attachment(s) omitted because image input is disabled.]",
            },
          ],
        },
      ]);
      expect(JSON.stringify(disabled)).not.toContain("private-image-bytes");
    });

    test("encodes enabled and disabled tool image observations", () => {
      const context: ModelContext = {
        messages: [
          {
            ...messageIdentityForTest("assistant"),
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "call-view",
                name: "view_image",
                args: { path: "screen.png" },
              },
            ],
          },
          {
            ...messageIdentityForTest("tool"),
            role: "tool",
            toolCallId: "call-view",
            toolName: "view_image",
            content: "Viewed screen.png",
            images: [
              {
                mimeType: "image/png",
                data: "tool-image-bytes",
                width: 32,
                height: 16,
              },
            ],
            isError: false,
          },
        ],
      };

      const enabled = buildRequest({ ...context, imageInput: true });
      const disabled = buildRequest({ ...context, imageInput: false });

      expect(enabled.input).toEqual([
        {
          type: "function_call",
          call_id: "call-view",
          name: "view_image",
          arguments: '{"path":"screen.png"}',
        },
        {
          type: "function_call_output",
          call_id: "call-view",
          output: [
            { type: "input_text", text: "Viewed screen.png" },
            { type: "input_image", image_url: "data:image/png;base64,tool-image-bytes" },
          ],
        },
      ]);
      expect(disabled.input).toEqual([
        {
          type: "function_call",
          call_id: "call-view",
          name: "view_image",
          arguments: '{"path":"screen.png"}',
        },
        {
          type: "function_call_output",
          call_id: "call-view",
          output:
            "Viewed screen.png\n\n[1 tool image observation(s) omitted because image input is disabled.]",
        },
      ]);
      expect(JSON.stringify(disabled)).not.toContain("tool-image-bytes");
    });
  });
}
