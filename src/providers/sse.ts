import { isRecord } from "@/utils";

// Reads a server-sent event stream whose data payloads are JSON objects.
// `[DONE]` ends the stream; every received chunk counts as activity.
export async function readSseJson(
  response: Response,
  label: string,
  onEvent: (event: Record<string, unknown>) => void,
  onActivity?: () => void,
): Promise<void> {
  if (!response.body) {
    throw new Error(`${label} response does not contain a body.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  // Returns true once the stream signals completion with [DONE].
  const applyFrame = (frame: string): boolean => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();
    if (data === "[DONE]") return true;
    if (!data) return false;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch (error) {
      throw new Error(`${label} stream returned invalid JSON.`, { cause: error });
    }
    if (!isRecord(event)) {
      throw new Error(`${label} stream event must be an object.`);
    }
    onEvent(event);
    return false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (applyFrame(frame)) return;
      }
    }
    buffer += decoder.decode();
    applyFrame(buffer);
    finished = true;
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
