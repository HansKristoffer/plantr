# plantr - AI Agent Guide

A TypeScript seeder library for Bun and Node.js (>= 22) with built-in faker, step, and expect support. On Bun, `expect` defaults to `bun:test`; on Node.js, it uses a zero-dependency `node:assert/strict` fallback (or a caller-supplied `expect`).

The user guide and API reference is [readme.md](readme.md); it ships on npm. Keep it the one place that documents behaviour, and update it in the same change as the code.

## Working here

- `bun install`, then `bun run lint` (tsgo typecheck + biome), `bun test`, `bun run build`, `bun run verify:package`. CI runs the same four.
- Tests sit next to the code as `src/*.test.ts`; `src/integration.test.ts` drives the public API, including `runCli`, and `src/types.test.ts` asserts compile-time TypeScript behavior.
- Use explicit `.js` extensions on relative imports/exports so emitted `dist/*.d.ts` declarations resolve cleanly under both `bundler` and `NodeNext` `moduleResolution`. `verify:package` checks both (without `@types/bun` as well as with `@types/bun`) and runs smoke checks on both Node.js and Bun.
- Conventional commit and PR titles (`fix:`, `feat:`, `feat!:` plus a `BREAKING CHANGE:` footer). Release Please cuts the version from them; see [docs/releasing.md](docs/releasing.md).
- A new entry point needs an `exports` entry in `package.json`, a file in `files`, an entry in `build:js` and `tsconfig.build.json`; `verify:package` imports every export from the packed tarball.

## Architecture

```
plantr/
├── index.ts                       # Public exports
├── state.ts                       # `plantr/state`: isSeedingActive without faker or bun:test
└── src/
    ├── types.ts                   # Type definitions (BaseSeederContext, RunSeedersOptions, ...)
    ├── create-seeder-instance.ts  # Factory: wires context, step runner, expect, seeding flag, CLI
    ├── cli.ts                     # runSeedersCli argument parsing (node:util parseArgs, strict)
    ├── define-seeder.ts           # Seeder definition
    ├── run-seeders.ts             # Core runner, target guard (describeTarget, SeedTargetError)
    ├── dependency-resolver.ts     # Topological sort, `only` selection, registry errors
    ├── step.ts                    # Step runner with versioned cache envelope, getAll/setMany batching
    ├── expect.ts                  # Portable ExpectFn types, dynamic bun:test loader, node:assert/strict fallback
    ├── lazy-faker.ts              # Lazy-loaded English faker proxy (defers locale load until first access)
    ├── seeding-state.ts           # Seeding flag on globalThis (shared by both entry points)
    └── formatting.ts              # Output formatting and runtime-safe inspectValue helper
```

Run order inside `runSeeders`: validate the registry and options (throws) → target guard (throws) → seeding flag on (ref-counted) → `onBeforeAll` → `cache.getAll()` preload (if configured) → context factory → seeders (sequential or critical-path parallel DAG) → results → `cache.setMany()` flush (if configured) → `onAfterAll(ctx)` → flag off.
