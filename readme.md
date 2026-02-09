# plantr

A Bun-first database seeder library with built-in faker, step workflow, and type-safe dependencies.

## Features

- **Built-in utilities** - `faker`, `step`, and `expect` available in every seeder
- **Type-safe dependencies** - Seeder outputs are fully typed when used as dependencies
- **Automatic ordering** - Seeders run in correct order based on dependencies
- **Step workflow** - Organize seeders into steps with progress logging
- **Step caching** - Cache expensive operations across runs
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
    ...base,
    prisma,
  }),
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
bun run src/seed.ts --help      # Show help
bun run src/seed.ts --dry-run   # Show execution order without running
```

## API

### `createSeederInstance(config)`

```typescript
createSeederInstance({
  // Required: factory that receives base context and returns your context
  context: (base) => ({ ...base, prisma }),
  
  // Optional: cache for step caching
  cache: {
    get: async (key) => { /* return cached value */ },
    set: async (key, value) => { /* store value */ },
  },
  
  // Optional: lifecycle hooks
  onBeforeAll: async () => { /* setup */ },
  onAfterAll: async () => { /* teardown */ },
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
await runSeeders(seeders, {
  printResults: true,      // Print results table (default: true)
  verbose: true,           // Print progress (default: true)
  continueOnFailure: false // Continue after failures (default: false)
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
}
```

## Seeding State

Check if seeding is active to skip side effects:

```typescript
import { isSeedingActive } from './seed'

// In your event handlers, webhooks, etc.
if (isSeedingActive()) {
  console.log('Skipping notification during seeding')
  return
}
```

## Error Handling

```typescript
import { CircularDependencyError, MissingDependencyError } from 'plantr'

try {
  await runSeeders(seeders)
} catch (error) {
  if (error instanceof CircularDependencyError) {
    console.error('Circular dependency detected')
  }
  if (error instanceof MissingDependencyError) {
    console.error('Missing dependency')
  }
}
```

## License

MIT
