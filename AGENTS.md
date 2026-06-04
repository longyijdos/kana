# AGENTS.md

This project is a personal TypeScript/Bun agent runtime.

## Development Guidelines

- Prefer small, explicit changes that follow the current module boundaries.
- Add comments for non-obvious design decisions, protocol semantics, stream
  ordering, provider-specific mappings, and mutable state boundaries.
- Do not add comments that only restate the code.
- Use `getModel(config)` to create configured model instances.
  Model instances hold model/network/generation config and receive the full
  context when invoked.
- Maintain one model execution path: model instances implement streaming, and
  non-streaming generation is derived from the stream result.
- Treat `snapshot` in assistant events as the assistant message after applying
  the current event. Do not emit shared mutable message objects as snapshots.
- Use TypeBox schemas for tool parameters so provider adapters can pass JSON
  Schema-compatible tool descriptions through directly.

## Current Architecture

- `src/core` contains provider-facing protocol types and stream primitives.
- `src/tools` contains tool descriptions and executable tool types.
- `src/providers` contains provider adapters and the `getModel` factory.
- `src/main.ts` is a manual smoke-test CLI, not the public library API.
