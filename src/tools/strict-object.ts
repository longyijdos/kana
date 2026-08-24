import { type TObject, type TProperties, Type } from "typebox";

// Kana-owned tool parameter schemas are strict: arguments not declared in the
// schema are rejected during validation instead of being silently ignored,
// which could otherwise turn an invalid model call into a plausible no-op.
// External/MCP schemas keep their own declared additionalProperties behavior.
export function strictObject<Properties extends TProperties>(
  properties: Properties,
): TObject<Properties> {
  return Type.Object(properties, { additionalProperties: false });
}
