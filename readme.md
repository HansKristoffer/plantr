# plantr

A Bun-first database seeder library with built-in faker, step workflow, and type-safe dependencies.

## Features

- **Built-in utilities** - `faker`, `step`, and `expect` available in every seeder
- **Type-safe dependencies** - Seeder outputs are fully typed when used as dependencies
- **Automatic ordering** - Seeders run in correct order based on dependencies
- **Run a subset** - Run named seeders plus what they depend on (`--only`, `only`)
- **Step workflow** - Organize seeders into steps with progress logging
- **Step caching** - Skip steps that already ran, with versions and a `--fresh` override
- **Target guard** - Refuse to seed a database that is not local unless asked to
- **Lifecycle hooks** - `onBeforeAll` / `onAfterAll` for setup and teardown
- **Continue on failure** - Keep seeding independent data when one seeder fails
- **Dry run mode** - Preview execution order without running

## Installation

```bash
bun add plantr
```

> **Note:** This library requires Bun as it uses `bun:test` for assertions.

## Quick Start

### 1. Create a Seeder Instance

```typescript
// src/seed.ts
import { createSeederInstance, type BaseSeederContext } from 'plantr'
import { prisma } from './prisma'

type MyContext = BaseSeederContext & {
  prisma: typeof prisma
}

export const { defineSeeder, runSeeders, runSeedersCli } = createSeederInstance<MyContext>({
  context: (base) => ({
    ...base, // faker, step, expect
    prisma,
  }),
  target: () => process.env.DATABASE_URL,
  onBeforeAll: async () => {
    await prisma.$connect()
  },
  onAfterAll: async () => {
    await prisma.$disconnect()
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

## CLI Options

```bash
bun run src/seed.ts                       # Run every seeder
bun run src/seed.ts postSeeder            # Run postSeeder and the seeders it depends on
bun run src/seed.ts --only a,b            # Same as naming them
bun run src/seed.ts postSeeder --fresh    # Ignore and overwrite postSeeder's cached steps
bun run src/seed.ts --fresh               # Ignore and overwrite every cached step
bun run src/seed.ts --continue-on-failure # Keep running seeders that do not depend on a failed one
bun run src/seed.ts --allow-remote        # Seed a target that is not local (see Target guard)
bun run src/seed.ts --dry-run postSeeder  # Show execution order without running
bun run src/seed.ts --help                # Show help
```

An unknown flag or seeder name prints the problem and exits 1 without seeding. `runSeedersCli` calls `process.exit`; pass `argv` to parse something other than `process.argv.slice(2)`. To embed seeding in your own CLI, call `runSeeders` with the options below instead.

## API

### `createSeederInstance(config)`

```typescript
createSeederInstance({
  // Required: factory that receives base context and returns your context.
  // Called once per run, after onBeforeAll.
  context: (base) => ({ ...base, prisma }),

  // Optional: cache for step caching (see Step Caching)
  cache: {
    get: async (key) => { /* return the stored value, or undefined */ },
    set: async (key, value) => { /* store value, overwriting */ },
  },

  // Optional: the database URL the run writes to (see Target guard)
  target: () => process.env.DATABASE_URL,

  // Optional: seed faker per seeder (fakerSeed + hash of the seeder name),
  // so every run generates the same data
  fakerSeed: 1,

  // Optional: lifecycle hooks
  onBeforeAll: async () => { /* setup; throw to refuse the run */ },
  onAfterAll: async () => { /* teardown; also runs when a seeder or the context factory throws */ },
})
```

Returns `{ defineSeeder, runSeeders, runSeedersCli, isSeedingActive }`.

### `defineSeeder(config)`

```typescript
defineSeeder({
  name: 'seederName',           // Unique name
  description: 'What it does',  // Optional
  dependsOn: [otherSeeder],     // Optional dependencies
  run: async (ctx, deps) => {
    // ctx has faker, step, expect, and your custom context
    // deps has typed outputs from dependsOn seeders
    return { /* output available to dependents */ }
  },
})
```

### `runSeeders(seeders, options?)`

```typescript
const { results, success } = await runSeeders(seeders, {
  printResults: true,       // Print results table and errors (default: true)
  verbose: true,            // Print progress and step lines (default: true)
  continueOnFailure: false, // Continue after failures (default: false)
  only: ['postSeeder'],     // Run these and what they depend on (default: all)
  fresh: ['postSeeder'],    // Ignore cached steps: true for all, or seeder names
  allowRemote: false,       // Seed a non-local target (default: false)
})
```

`success` is false when a seeder failed; each failed result carries `error`, `failedStep` (the step that threw) and `cachedSteps` (steps that replayed from the cache before it).

`runSeeders` **throws**, before any hook or seeder runs, when the input is invalid: `DuplicateSeederError`, `MissingDependencyError`, `CircularDependencyError`, `UnknownSeederError` (a name in `only` or `fresh`), or `SeedTargetError`.

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

  // Versioned cached step: a different version reruns it and overwrites the entry
  await step('Apply widget settings', () => applySettings(SETTINGS), {
    useCache: true,
    version: SETTINGS, // any JSON value, e.g. 2 or the data the step writes
  })
}
```

## Step Caching

A cached step stores its output under the key `<seederName>:<slugified description>` and returns the stored output on later runs instead of running again.

- **Nothing else invalidates an entry.** Editing the step's code or the data it uses does not; bump `version` when the output should change, or run the seeder `fresh` (`--only x --fresh`). Rows deleted from the database leave their ids in the cache, so run fresh after a reset that keeps the cache.
- **Each cached step needs a unique description within its seeder.** Two cached steps with the same key in one run throw.
- **The value passes through your store.** With a JSON column, a `Date` comes back as a string and a `Map` as `{}` on the next run, so return plain JSON (ids) from cached steps.
- **Every step must be safe to run again**: a version change, `fresh`, or a cleared cache reruns it against existing data.
- plantr stores an envelope, `{ __plantr: 1, version?, value }`, so a step that returns `undefined` is cached too. Values written bare by plantr 1.x are still read as hits (when the step has no `version`).

A Prisma store:

```typescript
cache: {
  get: async (key) => {
    const row = await prisma.seedCache.findUnique({ where: { key } })
    return row?.output as never
  },
  set: async (key, value) => {
    const output = value as Prisma.InputJsonValue
    await prisma.seedCache.upsert({ where: { key }, create: { key, output }, update: { output } })
  },
}
```

## Target guard

Set `target` to the database URL the instance writes to. The banner then shows its host and database, never credentials (`🌱 Running Seeders → localhost:5432/app`), and a run refuses with `SeedTargetError` before `onBeforeAll` when the host is not local. Local means loopback (`localhost`, `127.*`, `::1`), `*.localhost`, `host.docker.internal`, a socket or file path, or a name without a dot such as a compose service. Seed anything else on purpose with `allowRemote: true` or `--allow-remote`, for example in a staging pre-deploy command.

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

The flag is set for the duration of `runSeeders` and cleared afterwards, also when a hook throws. It is one flag per process, shared by every seeder instance, so it only reports seeding that runs in the same process.

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
    console.error(`${failed?.name} failed in step ${failed?.failedStep}`, failed?.error)
  }
} catch (error) {
  // The registry or options are invalid, or the target was refused; nothing ran
  if (error instanceof CircularDependencyError) console.error('Circular dependency')
  if (error instanceof SeedTargetError) console.error(error.message)
}
```

When a seeder fails, the summary names the failing step and prints the whole error with `Bun.inspect` (message, stack, `cause` and extra fields). Under GitHub Actions it also prints an `::error` annotation.

## License

MIT

## Releasing

Squash PRs with conventional titles (`fix:`, `feat:`, or `feat!:`). Release Please keeps the version and changelog in a release PR; merge that PR to publish with release notes and npm provenance. See [release and recovery instructions](docs/releasing.md).
