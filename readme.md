# plantr

A TypeScript database seeder library for **Bun and Node.js (>= 22)** with built-in faker, step workflow, parallel DAG execution, and end-to-end TypeScript inference.

## Features

- **Bun & Node.js (>= 22)** - Runs natively on both Bun and Node.js (`node`, `tsx`, `ts-node`, `vitest`) with zero extra dependencies
- **Built-in utilities** - `faker`, `step`, and `expect` available in every seeder (`faker` is lazy-loaded on first access, English locale only by default; `expect` uses `bun:test` on Bun, a built-in `node:assert/strict` implementation on Node.js, or your own `expect` such as Vitest's)
- **End-to-end TypeScript** - Zero-boilerplate context inference, context-safe seeder registries, typed dependencies, typed `outputs`, discriminated-union `results`, compile-time missing dependency checks, and autocompleted `only`/`fresh`
- **Automatic ordering & parallel DAG execution** - Runs in dependency order with critical-path scheduling across independent branches via `concurrency` / `--concurrency`
- **Run a subset** - Run named seeders plus what they depend on (`--only`, `only`)
- **Step workflow** - Organize seeders into sequential or `Promise.all` parallel steps with progress logging, and `mapWithLimit` for thousands of API calls a few at a time
- **Step caching** - Skip steps that already ran, with explicit keys, canonical JSON versions, single-query `getAll` preloading, batched `setMany` writes, and a `--fresh` override
- **Target guard** - Refuse to seed a database or emulator target that is not local unless asked to
- **Setup and teardown** - `setup()` returns the run's resources (a connection, a signed-in client) for the context factory, and `teardown(resources)` always runs: after a failure, when the context factory throws, and on SIGINT or SIGTERM
- **Continue on failure** - Keep seeding independent data when one seeder fails
- **Dry run & list modes** - Preview execution order, target, and descriptions without running

## Installation

```bash
bun add plantr
# or with pnpm / npm on Node.js >= 22
pnpm add plantr
```

> **Runtime support:** Works on **Bun >= 1.0** and **Node.js >= 22**. On Bun, `expect` delegates to `bun:test`. On Node.js, `expect` uses a zero-dependency fallback backed by `node:assert/strict` (covering `toBe`, `toEqual`, `toStrictEqual`, `toBeDefined`, `toBeUndefined`, `toBeNull`, `toBeTruthy`, `toBeFalsy`, `toContain`, `toHaveLength`, `toMatch`, `toBeGreaterThan`, `toBeGreaterThanOrEqual`, `toBeLessThan`, `toBeLessThanOrEqual`, `toThrow`, and `.not.*`), or pass your own `expect` (for example Vitest's `expect`) via `createSeederInstance({ expect })`.

## Quick Start

### 1. Create a Seeder Instance

```typescript
// src/seed.ts
import { createSeederInstance } from 'plantr'
import { PrismaClient } from '@prisma/client'

export const { defineSeeder, runSeeders, runSeedersCli } = createSeederInstance({
  target: () => process.env.DATABASE_URL,
  // Optional: acquire what the run needs; teardown always gets it back
  setup: async () => {
    const prisma = new PrismaClient()
    await prisma.$connect()
    return { prisma }
  },
  teardown: ({ prisma }) => prisma.$disconnect(),
  // Optional: extra properties are merged onto { faker, step, expect } automatically
  context: (_base, { prisma }) => ({ prisma }),
})
```

### 2. Define Seeders

```typescript
// src/seeders/userSeeder.ts
import { defineSeeder } from '../seed'

export const userSeeder = defineSeeder({
  name: 'userSeeder',
  description: 'Creates test users',
  run: async ({ prisma, faker, step, expect }) => {
    const user = await step('Create admin user', async () => {
      return prisma.user.create({
        data: {
          name: faker.person.fullName(),
          email: faker.internet.email(),
          role: 'admin',
        },
      })
    })

    expect(user.id).toBeDefined()

    return { userId: user.id }
  },
})
```

### 3. Define Seeders with Dependencies

```typescript
// src/seeders/postSeeder.ts
import { defineSeeder } from '../seed'
import { userSeeder } from './userSeeder'

export const postSeeder = defineSeeder({
  name: 'postSeeder',
  description: 'Creates posts for users',
  dependsOn: [userSeeder],
  run: async ({ prisma, faker, step }, deps) => {
    // deps.userSeeder is fully typed!
    const { userId } = deps.userSeeder

    const post = await step('Create post', async () => {
      return prisma.post.create({
        data: {
          title: faker.lorem.sentence(),
          authorId: userId,
        },
      })
    })

    return { postId: post.id }
  },
})
```

### 4. Run Seeders

```typescript
// src/seed.ts (continued)
import { userSeeder } from './seeders/userSeeder'
import { postSeeder } from './seeders/postSeeder'

const seeders = [userSeeder, postSeeder] as const

if (import.meta.main) {
  runSeedersCli(seeders)
}
```

Run with:
```bash
bun run src/seed.ts
# or on Node.js:
npx tsx src/seed.ts
```

Or programmatically (e.g. in tests) with fully typed `outputs`:

```typescript
const run = await runSeeders([userSeeder, postSeeder])
if (run.success) {
  console.log(run.outputs.userSeeder.userId, run.outputs.postSeeder.postId)
}
```

## CLI Options

```bash
bun run src/seed.ts                       # Run every seeder
bun run src/seed.ts postSeeder            # Run postSeeder and the seeders it depends on
bun run src/seed.ts --only a,b            # Same as naming them
bun run src/seed.ts postSeeder --fresh    # Ignore and overwrite postSeeder's cached steps
bun run src/seed.ts --fresh               # Run onFresh (see Fresh runs), then ignore and overwrite every cached step
bun run src/seed.ts --concurrency 4       # Run up to 4 independent seeders in parallel (-c 4)
bun run src/seed.ts --continue-on-failure # Keep running seeders that do not depend on a failed one
bun run src/seed.ts --allow-remote        # Seed a target that is not local (see Target guard)
bun run src/seed.ts --quiet               # Suppress progress/step lines, keep results table (-q)
bun run src/seed.ts --dry-run postSeeder  # Show execution order, target, and descriptions without running
bun run src/seed.ts --list                # List registered seeders in dependency order (-l)
bun run src/seed.ts --help                # Show help and registered seeders (-h)
```

An unknown flag, invalid `--concurrency`, or unknown seeder name prints the problem and exits 1 without seeding. `runSeedersCli` calls `process.exit`; pass `argv` to parse something other than `process.argv.slice(2)`. To embed seeding in your own CLI, call `runSeeders` with the options below instead.

## API

### `createSeederInstance(config?)`

```typescript
createSeederInstance({
  // Optional: acquire the run's resources (see Setup and teardown); throw to refuse the run
  setup: async ({ defer }) => ({ prisma: await connect() }),

  // Optional: release them; runs whenever setup returned, also on failure and SIGINT/SIGTERM
  teardown: async ({ prisma }) => { await prisma.$disconnect() },

  // Optional: factory returning extra properties to merge onto { faker, step, expect }.
  // Receives `base` if you want to build helpers around faker/step/expect or override a base key,
  // and the resources setup returned. Called once per run, after setup. Omit to use BaseSeederContext directly.
  context: (base, { prisma }) => ({ prisma }),

  // Optional: cache for step caching (see Step Caching), or a function of setup's
  // resources returning one: cache: ({ db }) => createCache(db)
  cache: {
    get: async (key) => { /* return the stored value, or undefined / null */ },
    set: async (key, value) => { /* store value, overwriting */ },
    getAll: async () => { /* optional: preload all entries in one query */ },
    setMany: async (entries) => { /* optional: flush all writes in one batch at end of run */ },
  },

  // Optional: reset the target before a fresh run (see Fresh runs)
  onFresh: async ({ resources, seeders, all }) => { if (all) await resources.db.wipe() },

  // Optional: default parallel concurrency for independent seeders (default: 1; e.g. 4 or Infinity)
  concurrency: 4,

  // Optional: custom Faker locale instance (default: lazy-loaded @faker-js/faker/locale/en)
  faker: fakerDE,

  // Optional: custom `expect` implementation (e.g. Vitest's `expect`).
  // Defaults to `bun:test` on Bun and a built-in `node:assert/strict` fallback on Node.js.
  expect: vitestExpect,

  // Optional: the database or emulator URL the run writes to (see Target guard)
  target: () => process.env.DATABASE_URL,

  // Optional: seed faker per seeder (fakerSeed + hash of the seeder name),
  // so every run generates the same data even when running concurrently
  fakerSeed: 1,

  // Optional, with fakerSeed: also seed each step's faker from its key (see Deterministic data)
  fakerSeedScope: 'step', // default: 'seeder'

  // Deprecated: use setup and teardown (see Migrating from onBeforeAll and onAfterAll)
  onBeforeAll: async () => { /* runs before setup; throw to refuse the run */ },
  onAfterAll: async (ctx) => { /* runs before teardown; ctx is undefined if context() threw */ },
})
```

Returns `{ defineSeeder, runSeeders, runSeedersCli, isSeedingActive }`.

### `defineSeeder(config)`

```typescript
defineSeeder({
  name: 'seederName',           // Unique name
  description: 'What it does',  // Optional
  dependsOn: [otherSeeder],     // Optional dependencies (must have a compatible context)
  run: async (ctx, deps) => {   // Sync or async
    // ctx has faker, step, expect, and your custom context
    // deps has typed outputs from dependsOn seeders
    return { /* output available to dependents and run.outputs */ }
  },
})
```

### `runSeeders(seeders, options?)`

```typescript
const run = await runSeeders(seeders, {
  printResults: true,       // Print results table and errors (default: true)
  verbose: true,            // Print progress and step lines (default: true)
  continueOnFailure: false, // Continue after failures (default: false)
  only: ['postSeeder'],     // Autocompleted & checked against seeders (default: all)
  fresh: ['postSeeder'],    // Ignore cached steps: true for all, or checked seeder names
  allowRemote: false,       // Seed a non-local target (default: false)
  concurrency: 1,           // Max independent seeders running in parallel (default: 1; supports Infinity)
  handleSignals: true,      // Tear down and exit on SIGINT/SIGTERM while running (default: true)
})
```

`run` is a discriminated union on `success`:
- When `run.success` is `true`, `run.outputs` carries every completed seeder's typed output (non-optional for all seeders when `only` is omitted, or for the named seeders when `only` is set).
- `run.results` is a discriminated union by `status` (`'completed' | 'failed' | 'skipped' | 'pending'`). Narrowing on `r.status === 'failed'` gives non-optional `r.error`, `r.durationMs`, `r.failedStep`, and `r.cachedSteps`; narrowing on `r.status === 'skipped'` gives `r.failedDeps`.
- Passing a seeder list that omits a declared dependency is caught at compile time by TypeScript as well as at runtime.

When `concurrency > 1` (configured on `createSeederInstance`, per `runSeeders` call, or via `--concurrency` / `-c`):
- Independent branches of the dependency graph run in parallel, prioritized by **critical-path depth** (longest downstream dependency chains start first so leaf seeders backfill idle slots).
- Each seeder receives lazily-initialized, `AsyncLocalStorage`-isolated `step` and `faker` scopes (so `fakerSeed`, step cache keys, and helpers built around `base.step`/`base.faker` remain deterministic and race-free, and cached seeders that never touch `faker` pay zero setup cost).
- Running `--dry-run` with `concurrency > 1` displays the execution plan grouped into parallel waves so you can inspect your DAG structure.
- Inside a single seeder, independent steps can also run concurrently with `await Promise.all([step(...), step(...)])`.

`runSeeders` **throws**, before any hook or seeder runs (and before setting the seeding flag), when the input is invalid: `DuplicateSeederError`, `MissingDependencyError`, `CircularDependencyError`, `UnknownSeederError` (a name in `only` or `fresh`), `RangeError` (invalid `concurrency`), or `SeedTargetError`.

### Setup and teardown

`setup` acquires what the run needs and returns it; the context factory, a `cache` factory and `teardown` receive what it returned. A run goes:

1. Validate the registry and options, then the target guard (both throw before anything else).
2. `onBeforeAll` (deprecated), then `setup`.
3. The `cache` factory, `onFresh` on a fresh run, the cache preload.
4. The context factory, the seeders, the results table.
5. Cleanup: flush the step cache, `onAfterAll(ctx)` (deprecated), `teardown(resources)`, then the deferred cleanups, last registered first.

Each cleanup step runs whenever the step it undoes completed, whatever failed after it:

- **A seeder fails**: the run finishes as usual (`success: false`) and tears down.
- **The context factory or the `cache` factory throws**: `teardown` gets the resources, then the run rethrows the error.
- **`setup` throws after acquiring part of its resources**: `teardown` does not run, because `setup` returned nothing to pass it. Register each resource's cleanup with `defer` as soon as you acquire it; deferred cleanups run when `setup` throws later, and after `teardown` on a run that got that far.
- **SIGINT or SIGTERM** (Ctrl+C, `docker stop`, CI cancel): no further seeder starts, the cleanup above runs once, and the process exits with 130 or 143. Seeders already running are not awaited. A second signal exits at once. Pass `handleSignals: false` to `runSeeders` to keep your own signal handlers in charge.
- **A cleanup step throws**: the rest still run. The run rethrows the first error (the one that stopped the run, if any) and prints the others to stderr.

```typescript
createSeederInstance({
  setup: async ({ defer }) => {
    const db = await connectDb()
    defer(() => db.close())             // runs even if signing in below throws
    const api = await signIn(db, credentials)
    return { db, api }
  },
  teardown: async ({ api }) => {
    await api.signOut()                 // then the deferred db.close()
  },
  context: (_base, { db, api }) => ({ db, api }),
})
```

#### Migrating from `onBeforeAll` and `onAfterAll`

Both still run (`onBeforeAll` before `setup`, `onAfterAll` before `teardown`) and are deprecated. Move a connection opened in `onBeforeAll` and closed in `onAfterAll` into `setup` and `teardown`, and drop the module-level variable that carried it between them:

```typescript
// Before
let db: Db | undefined
createSeederInstance({
  onBeforeAll: async () => { assertLocal(); db = await connectDb() },
  context: () => ({ db: db! }),
  onAfterAll: async () => { await db?.close() },
})

// After
createSeederInstance({
  setup: async () => { assertLocal(); return { db: await connectDb() } },
  context: (_base, { db }) => ({ db }),
  teardown: ({ db }) => db.close(),
})
```

### Step Function

```typescript
run: async ({ step }) => {
  // Basic step
  const result = await step('Create user', async () => {
    return prisma.user.create({ ... })
  })

  // Cached step (requires cache config)
  const cached = await step('Expensive operation', async () => {
    return computeExpensiveValue()
  }, { useCache: true })

  // Versioned cached step with an explicit stable key
  await step('Apply widget settings', () => applySettings(SETTINGS), {
    useCache: true,
    key: 'widget-settings', // optional: keeps the key stable if the description changes
    version: SETTINGS,      // any JSON value; object keys are compared order-independently
  })
}
```

### `mapWithLimit(items, limit, fn)`

Runs `fn(item, index)` over `items` (any iterable) with at most `limit` calls in flight, for example thousands of API calls eight at a time, and resolves to the results in the order of `items`, whatever order the calls finish in. `limit` is a positive integer or `Infinity`; anything else throws `RangeError`.

```typescript
import { mapWithLimit } from 'plantr'

await step('Create products', () =>
  mapWithLimit(products, 8, (product) => api.post('/products', product)),
)
```

It fails fast: once a call throws or rejects, no further item starts, and it rejects with that first error after the calls already in flight have settled. Nothing it started is still running when the step fails and the run tears down.

Calls in one step share its faker, and later items start as earlier ones finish, so faker draws inside `fn` come out in a different order on each run. Build the items with faker first and keep `fn` to sending them.

## Step Caching

A cached step stores its output under the key `<seederName>:<key or slugified description>` and returns the stored output on later runs instead of running again.

- **Nothing else invalidates an entry.** Editing the step's code or the data it uses does not; bump `version` when the output should change, or run the seeder `fresh` (`--only x --fresh`). Rows deleted from the database leave their ids in the cache, so run fresh after a reset that keeps the cache.
- **Each cached step needs a unique key within its seeder.** Two cached steps with the same key in one run throw. Pass `key` if you want to reword descriptions freely or use non-ASCII descriptions.
- **The value passes through your store.** With a JSON column, a `Date` comes back as a string and a `Map` as `{}` on the next run, so return plain JSON (ids) from cached steps.
- **Every step must be safe to run again**: a version change, `fresh`, or a cleared cache reruns it against existing data.
- plantr stores an envelope, `{ __plantr: 1, version?, value }`, so a step that returns `undefined` or `null` is cached too, while `undefined` or `null` returned bare from `cache.get` is treated as a cache miss. Non-null values written bare by plantr 1.x are still read as hits (when the step has no `version`).
- Pass `cache` as a function to build it from the resources `setup` returned: `cache: ({ db }) => createCache(db)`. It runs once per run, after `setup` and before the preload, so a cache stored in the seeded database needs no connection of its own. Return `undefined` to run without a cache.
- Provide `getAll` on `cache` to preload the entire table in a single query at the start of each run instead of issuing one `get` query per cached step, and `setMany` to flush new/updated entries in one batch write before `onAfterAll` (even if a later seeder fails).

A Prisma store, with the client from `setup`:

```typescript
cache: ({ prisma }) => ({
  get: async (key) => {
    const row = await prisma.seedCache.findUnique({ where: { key } })
    return row?.output
  },
  getAll: async () => {
    const rows = await prisma.seedCache.findMany()
    return new Map(rows.map((r) => [r.key, r.output]))
  },
  set: async (key, value) => {
    const output = value as Prisma.InputJsonValue
    await prisma.seedCache.upsert({ where: { key }, create: { key, output }, update: { output } })
  },
  setMany: async (entries) => {
    await prisma.$transaction(
      entries.map(({ key, value }) => {
        const output = value as Prisma.InputJsonValue
        return prisma.seedCache.upsert({ where: { key }, create: { key, output }, update: { output } })
      }),
    )
  },
})
```

### Fresh runs

`fresh` (CLI `--fresh`) makes cached steps run again and overwrite their entries. When a step creates records whose ids the target picks, running it again creates them a second time. `onFresh` lets the project reset the target first:

```typescript
createSeederInstance({
  setup: async () => ({ db: await connectEmulator() }),
  onFresh: async ({ resources: { db }, seeders, all }) => {
    if (!all) {
      throw new SeedUsageError(`Run --fresh without seeder names to reset the emulator (asked: ${seeders.join(', ')})`)
    }
    await db.wipe()
  },
})
```

- It runs after `setup` and the `cache` factory and before the cache preload and the context factory, so it may wipe a cache stored in the target too.
- It runs only when at least one seeder of the run is fresh. `seeders` names them, in run order.
- `all` is true only when every registered seeder runs, and runs fresh: `fresh: true` without `only`, or `--fresh` without seeder names. With `--fresh` plus names (`seed post --fresh`), only the named seeders run fresh: the seeders they depend on still replay cached ids of records a wipe would delete. So wipe only when `all` is true, and either do nothing or refuse (as above) otherwise.
- If it throws, nothing is seeded and the run tears down.

## Deterministic data

With `fakerSeed`, `ctx.faker` is seeded per seeder from `fakerSeed` and the seeder's name, so every run generates the same data and adding a seeder does not shift the others.

A cached step skips its function, and with it the faker draws inside. With the default `fakerSeedScope: 'seeder'`, everything the seeder draws after that step comes out different on a run where the step was cached than on one where it ran. Either make every draw before the first step, or set `fakerSeedScope: 'step'`:

```typescript
createSeederInstance({ fakerSeed: 1, fakerSeedScope: 'step' })
```

Each step's function then gets its own faker, seeded from `fakerSeed`, the seeder's name and the step's `key` (or its description when it has none). A key used again in the same seeder (a step in a loop) gets a counter, so each iteration draws different data, in call order. The seeder's own faker never sees a step's draws, so:

- draws inside a step, and draws after it, are the same whether earlier steps ran or came from the cache;
- steps started together with `Promise.all` each draw their own sequence, whichever finishes first;
- renaming a step without a `key` changes what it generates, as it changes its cache key.

`'seeder'` stays the default because switching changes the data steps generate once. Seeders that draw nothing inside steps generate the same data under both. Without `fakerSeed`, `fakerSeedScope` has no effect.

## Target guard

Set `target` to the database or emulator URL the instance writes to (for example `process.env.DATABASE_URL`, `http://127.0.0.1:8080`, or `firestore://127.0.0.1:8080/demo-app`). The banner then shows its host and path, never credentials (`🌱 Running Seeders (2 seeders) → localhost:5432/app`), and a run refuses with `SeedTargetError` before `onBeforeAll` when the target is not local. Local means every host the URL names (several hosts, or a `host=` parameter, which overrides the URL's host) is loopback (`localhost`, `127.*`, `::1`, `0.0.0.0`), `*.localhost`, `host.docker.internal`, a socket directory or `file:` path, or a single-label hostname with an explicit port such as a compose service (`postgres:5432`). A bare name without a port (such as a cloud project URL like `firestore://my-prod-project`) or a target without a `scheme://` is refused. Seed anything else on purpose with `allowRemote: true` or `--allow-remote`, for example in a staging pre-deploy command.

Without `target` there is no check. For other rules (an environment variable, a list of allowed hosts), throw a `SeedUsageError` from `setup` before it connects; the CLI prints its message without a stack trace.

## Seeding State

Check if seeding is active to skip side effects. Runtime code (job queues, mailers, the API) should import it from `plantr/state`, which does not load faker, `bun:test`, or assertion helpers:

```typescript
import { isSeedingActive } from 'plantr/state'

// In your event handlers, webhooks, etc.
if (isSeedingActive()) {
  console.log('Skipping notification during seeding')
  return
}
```

The flag is set after validation succeeds and cleared when the run finishes, also when a hook throws. Overlapping runs in the same process are reference-counted so one finishing run does not clear the flag while another is still active.

## Error Handling

```typescript
import {
  CircularDependencyError,
  DuplicateSeederError,
  isSeedUsageError,
  MissingDependencyError,
  SeedTargetError,
  SeedUsageError,
  UnknownSeederError,
} from 'plantr'

try {
  const { success, results } = await runSeeders(seeders)
  if (!success) {
    const failed = results.find((r) => r.status === 'failed')
    if (failed) {
      console.error(`${failed.name} failed in step ${failed.failedStep}`, failed.error)
    }
  }
} catch (error) {
  // The registry or options are invalid, or the target was refused; nothing ran
  if (error instanceof CircularDependencyError) console.error('Circular dependency')
  if (error instanceof SeedTargetError) console.error(error.message)
}
```

### Usage errors

Throw `SeedUsageError` for a problem the person running the seed fixes by changing how they run it: a refused target, a missing environment variable, a bad option. `runSeedersCli` prints only its message, in red, and exits 1; a seeder that fails with one is reported by its message, without a stack trace. Every other error keeps its stack.

```typescript
setup: async () => {
  if (!process.env.SEED_ADMIN_URL) throw new SeedUsageError('Set SEED_ADMIN_URL to the Admin these emulators serve')
  return { db: await connect() }
},
```

plantr's own validation errors (`SeedTargetError`, `UnknownSeederError`, `DuplicateSeederError`, `MissingDependencyError`, `CircularDependencyError`) extend `SeedUsageError`. To mark an error class of your own without extending it, set the registered symbol `usageErrorSymbol` (`Symbol.for('plantr.usageError')`) to `true` on it; `isSeedUsageError(error)` checks for either.

When a seeder fails, the summary names the failing step and prints the whole error (`Bun.inspect` on Bun or `util.inspect` on Node.js: message, stack, `cause` and extra fields). Under GitHub Actions it also prints an `::error` annotation. Terminal colors respect `NO_COLOR`, `FORCE_COLOR`, and stdout TTY state.

## License

MIT

## Releasing

Squash PRs with conventional titles (`fix:`, `feat:`, or `feat!:`). Release Please keeps the version and changelog in a release PR; merge that PR to publish with release notes and npm provenance. See [release and recovery instructions](docs/releasing.md).
