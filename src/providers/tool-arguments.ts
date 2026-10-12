// Invalid JSON keeps the raw text so validation can report that the model
// produced malformed arguments instead of an empty object.
export function parseToolArguments(rawArgs: string): unknown {
  if (!rawArgs) {
    return {};
  }
  try {
    return JSON.parse(rawArgs);
  } catch {
    return rawArgs;
  }
}
