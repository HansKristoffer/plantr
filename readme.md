# plantr

A Bun-first database seeder library with built-in faker, step workflow, parallel DAG execution, and end-to-end TypeScript inference.

## Features

- **Built-in utilities** - `faker`, `step`, and `expect` available in every seeder (`faker` is lazy-loaded on first access, English locale only by default)
- **End-to-end TypeScript** - Zero-boilerplate context inference, context-safe seeder registries, typed dependencies, typed `outputs`, discriminated-union `results`, compile-time missing dependency checks, and autocompleted `only`/`fresh`
- **Automatic ordering & parallel DAG execution** - Runs in dependency order with critical-path scheduling across independent branches via `concurrency` / `--concurrency`
- **Run a subset** - Run named seeders plus what they depend on (`--only`, `only`)
- **Step workflow** - Organize seeders into sequential or `Promise.all` parallel steps with progress logging
- **Step caching** - Skip steps that already ran, with explicit keys, canonical JSON versions, single-query `getAll` preloading, batched `setMany` writes, and a `--fresh` override
- **Target guard** - Refuse to seed a database that is not local unless asked to
- **Lifecycle hooks** - `onBeforeAll` / `onAfterAll(ctx)` for setup and teardown
- **Continue on failure** - Keep seeding independent data when one seeder fails
- **Dry run & list modes** - Preview execution order, target, and descriptions without running

## Installation

```bash
bun add plantr
```

> **Note:** This library requires Bun as it uses `bun:test` for assertions.

## Quick Start

### 1. Create a Seeder Instance

```typescript
// src/seed.ts
import { createSeederInstance } from 'plantr'
import { prisma } from './prisma'

export const { defineSeeder, runSeeders, runSeedersCli } = createSeederInstance({
  // Optional: extra properties are merged onto { faker, step, expect } automatically
  context: () => ({ prisma }),
  target: () => process.env.DATABASE_URL,
  onBeforeAll: async () => {
    await prisma.$connect()
  },
  onAfterAll: async (ctx) => {
    await ctx?.prisma.$disconnect()
  },
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
bun run src/seed.ts --fresh               # Ignore and overwrite every cached step
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
  // Optional: factory returning extra properties to merge onto { faker, step, expect }.
  // Receives `base` if you want to build helpers around faker/step/expect or override a base key.
  // Called once per run, after onBeforeAll. Omit to use BaseSeederContext directly.
  context: (base) => ({ prisma }),

  // Optional: cache for step caching (see Step Caching)
  cache: {
    get: async (key) => { /* return the stored value, or undefined / null */ },
    set: async (key, value) => { /* store value, overwriting */ },
    getAll: async () => { /* optional: preload all entries in one query */ },
    setMany: async (entries) => { /* optional: flush all writes in one batch at end of run */ },
  },

  // Optional: default parallel concurrency for independent seeders (default: 1; e.g. 4 or Infinity)
  concurrency: 4,

  // Optional: custom Faker locale instance (default: lazy-loaded @faker-js/faker/locale/en)
  faker: fakerDE,

  // Optional: the database URL the run writes to (see Target guard)
  target: () => process.env.DATABASE_URL,

  // Optional: seed faker per seeder (fakerSeed + hash of the seeder name),
  // so every run generates the same data even when running concurrently
  fakerSeed: 1,

  // Optional: lifecycle hooks
  onBeforeAll: async () => { /* setup; throw to refuse the run */ },
  onAfterAll: async (ctx) => { /* teardown; receives ctx (or undefined if context() threw) */ },
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

## Step Caching

A cached step stores its output under the key `<seederName>:<key or slugified description>` and returns the stored output on later runs instead of running again.

- **Nothing else invalidates an entry.** Editing the step's code or the data it uses does not; bump `version` when the output should change, or run the seeder `fresh` (`--only x --fresh`). Rows deleted from the database leave their ids in the cache, so run fresh after a reset that keeps the cache.
- **Each cached step needs a unique key within its seeder.** Two cached steps with the same key in one run throw. Pass `key` if you want to reword descriptions freely or use non-ASCII descriptions.
- **The value passes through your store.** With a JSON column, a `Date` comes back as a string and a `Map` as `{}` on the next run, so return plain JSON (ids) from cached steps.
- **Every step must be safe to run again**: a version change, `fresh`, or a cleared cache reruns it against existing data.
- plantr stores an envelope, `{ __plantr: 1, version?, value }`, so a step that returns `undefined` or `null` is cached too, while `undefined` or `null` returned bare from `cache.get` is treated as a cache miss. Non-null values written bare by plantr 1.x are still read as hits (when the step has no `version`).
- Provide `getAll` on `cache` to preload the entire table in a single query at the start of each run instead of issuing one `get` query per cached step, and `setMany` to flush new/updated entries in one batch write before `onAfterAll` (even if a later seeder fails).

A Prisma store:

```typescript
cache: {
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
}
```

## Target guard

Set `target` to the database URL the instance writes to. The banner then shows its host and database, never credentials (`🌱 Running Seeders (2 seeders) → localhost:5432/app`), and a run refuses with `SeedTargetError` before `onBeforeAll` when the host is not local. Local means every host the URL names (several hosts, or a `host=` parameter, which overrides the URL's host) is loopback (`localhost`, `127.*`, `::1`), `*.localhost`, `host.docker.internal`, a socket directory or `file:` path, or a name without a dot such as a compose service. A target without a `scheme://` is refused. Seed anything else on purpose with `allowRemote: true` or `--allow-remote`, for example in a staging pre-deploy command.

Without `target` there is no check. For other rules (an environment variable, a list of allowed hosts), throw from `onBeforeAll`.

## Seeding State

Check if seeding is active to skip side effects. Runtime code (job queues, mailers, the API) should import it from `plantr/state`, which does not load faker or `bun:test`:

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
  MissingDependencyError,
  SeedTargetError,
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

When a seeder fails, the summary names the failing step and prints the whole error with `Bun.inspect` (message, stack, `cause` and extra fields). Under GitHub Actions it also prints an `::error` annotation. Terminal colors respect `NO_COLOR`, `FORCE_COLOR`, and stdout TTY state.

## License

MIT

## Releasing

Squash PRs with conventional titles (`fix:`, `feat:`, or `feat!:`). Release Please keeps the version and changelog in a release PR; merge that PR to publish with release notes and npm provenance. See [release and recovery instructions](docs/releasing.md).
