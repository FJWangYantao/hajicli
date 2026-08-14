# Haji native terminal engine

This Rust Node-API module accelerates ANSI wrapping and selection-document
layout. The CLI automatically falls back to the TypeScript implementation when
the current platform binary is absent or cannot be loaded.

Build the current platform binary from the repository root:

```sh
pnpm run build:full
```

Runtime selection:

- `HAJI_NATIVE_RENDERER=auto` (default): use Rust when available.
- `HAJI_NATIVE_RENDERER=on`: require Rust and fail if it cannot load.
- `HAJI_NATIVE_RENDERER=off`: always use the TypeScript fallback.

Use `/perf` to see which engine is active.
