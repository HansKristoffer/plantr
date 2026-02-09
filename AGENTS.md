# plantr - AI Agent Guide

A Bun-first seeder library with built-in faker, step, and expect support.

## Overview

`plantr` is a standalone library for creating database seeders with:
- **Built-in base context**: `faker`, `step`, and `expect` are always available
- Type-safe dependencies between seeders
- Automatic dependency resolution (topological sort)
- Extensible context - consumers add their own helpers (e.g. prisma)
- Beautiful CLI output with progress tracking
- Lifecycle hooks (`onBeforeAll`, `onAfterAll`)
- Continue on failure mode for development

**Note:** This library requires Bun as it uses `bun:test` for the expect function.

## Installation

```bash
bun add plantr
```

## Quick Start

### 1. Create a Seeder Instance

```typescript
// src/seed-instance.ts
import { createSeederInstance, type BaseSeederContext } from 'plantr'
import { prisma } from './prisma'

// Extend the base context with your own additions
type MySeederContext = BaseSeederContext & {
  prisma: typeof prisma
}

// Create the instance - base context (faker, step, expect) is passed to your factory
const { defineSeeder, runSeeders } = createSeederInstance<MySeederContext>({
  context: (base) => ({
    ...base,  // Spread to get faker, step, expect
    prisma,   // Add your own context
  }),
  onBeforeAll: () => console.log('Starting seeding...'),
  onAfterAll: () => console.log('Seeding complete!'),
})

export { defineSeeder, runSeeders }
```

### 2. Define Seeders

Seeders always have access to `faker`, `step`, and `expect` from the base context:

```typescript
// src/seeders/userSeeder.ts
import { defineSeeder } from '../seed-instance'

export default defineSeeder({
  name: 'userSeeder',
  description: 'Creates test users',
  run: async ({ prisma, faker, step, expect }) => {
    // faker - generate test data
    // step - organize workflow with logging
    // expect - assertions
    
    const user = await step('Create user', async () => {
      return prisma.user.create({
        data: {
          name: faker.person.fullName(),
          email: faker.internet.email(),
        }
      })
    })
    
    expect(user.id).toBeDefined()
    
    return { userId: user.id }
  }
})
```

### 3. Define Seeders with Dependencies

```typescript
// src/seeders/postSeeder.ts
import { defineSeeder } from '../seed-instance'
import userSeeder from './userSeeder'

export default defineSeeder({
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
        }
      })
    })
    
    return { postId: post.id }
  }
})
```

### 4. Run Seeders

```typescript
// src/seed.ts
import { runSeeders } from './seed-instance'
import userSeeder from './seeders/userSeeder'
import postSeeder from './seeders/postSeeder'

const seeders = [userSeeder, postSeeder] as const

if (import.meta.main) {
  const { success } = await runSeeders(seeders)
  process.exit(success ? 0 : 1)
}
```

## Base Context

The library provides these utilities in every seeder automatically:

| Property | Type | Description |
|----------|------|-------------|
| `faker` | `Faker` | Instance from `@faker-js/faker` for generating test data |
| `step` | `StepFn` | Organizes workflow with logging (shows ✓/✗ for each step) |
| `expect` | `ExpectFn` | Assertion function from `bun:test` |

### Step Function

The step function helps organize seeder workflow:

```typescript
run: async ({ step, faker, prisma }) => {
  // Each step logs its status (✓ or ✗)
  const user = await step('Create admin user', async () => {
    return prisma.user.create({ data: { name: faker.person.fullName() } })
  })
  
  // Use { useCache: true } to cache the result
  const settings = await step('Configure settings', async () => {
    return prisma.settings.create({ data: { userId: user.id } })
  }, { useCache: true })
  
  return { userId: user.id }
}
```

Output:
```
  userSeeder [1/3] Creates test users
    ✓ Create admin user
    ✓ Configure settings (cached)
  ✅ Completed in 45ms
```

### Step Caching

To enable step caching, provide a `cache` object when creating the seeder instance:

```typescript
const { defineSeeder, runSeeders } = createSeederInstance<MyContext>({
  context: (base) => ({ ...base, prisma }),
  cache: {
    get: async (key) => {
      const cached = await prisma.seedCache.findUnique({ where: { key } })
      return cached?.output
    },
    set: async (key, value) => {
      await prisma.seedCache.upsert({
        where: { key },
        create: { key, output: value },
        update: { output: value }
      })
    }
  }
})
```

Then use `{ useCache: true }` in step calls to enable caching for specific steps.

## API Reference

### `createSeederInstance<TContext>(config)`

Creates a seeder instance with your custom context.

```typescript
type SeederInstanceConfig<TContext extends BaseSeederContext> = {
  // Factory that receives base context (faker, step, expect) and returns full context
  context: (base: BaseSeederContext) => TContext | Promise<TContext>
  // Optional: cache for step caching
  cache?: {
    get: <T>(key: string) => Promise<T | undefined>
    set: <T>(key: string, value: T) => Promise<void>
  }
  // Optional: called before all seeders run
  onBeforeAll?: () => void | Promise<void>
  // Optional: called after all seeders complete
  onAfterAll?: () => void | Promise<void>
}
```

Returns `{ defineSeeder, runSeeders, runSeedersCli, isSeedingActive }`.

### `defineSeeder(config)`

Defines a seeder. Returns a `Seeder` object.

```typescript
type SeederConfig<TContext, TName, TOutput, TDeps> = {
  name: TName                    // Unique seeder name
  description?: string           // Optional description
  dependsOn?: TDeps              // Array of dependency seeders
  run: (ctx, deps) => Promise<TOutput>
}
```

### `runSeeders(seeders, options?)`

Runs seeders in dependency order.

```typescript
type RunSeedersOptions = {
  printResults?: boolean      // Print results table (default: true)
  verbose?: boolean           // Print progress output (default: true)
  continueOnFailure?: boolean // Continue running after failures (default: false)
}

// Returns
type RunResult = {
  results: SeederResult[]
  success: boolean
}
```

When `continueOnFailure` is true, seeders that depend on a failed seeder will be skipped, but independent seeders will still run. Useful for development when you want to seed as much data as possible.

### `runSeedersCli(seeders, options?)`

Runs seeders as a CLI command with built-in argument parsing.

```typescript
// At the bottom of your seed registry file:
if (import.meta.main) {
  runSeedersCli(seeders, { name: 'My App Seeders' })
}
```

CLI flags:
- `--help`, `-h`: Show help message
- `--dry-run`: Show execution order without running seeders

## Types

```typescript
import type {
  BaseSeederContext,      // { faker, step, expect }
  Seeder,
  SeederAny,
  SeederConfig,
  SeederResult,
  SeederInstanceConfig,
  SeederCache,            // { get, set } for step caching
  RunSeedersOptions,
  StepFn,
  StepOptions,
} from 'plantr'
```

## Re-exports

For convenience, the library re-exports faker and expect:

```typescript
import { faker, expect } from 'plantr'
```

## Error Handling

The library throws specific errors:

- `CircularDependencyError` - when seeders have circular dependencies
- `MissingDependencyError` - when a seeder depends on a non-existent seeder

```typescript
import {
  CircularDependencyError,
  MissingDependencyError,
} from 'plantr'

try {
  await runSeeders(seeders)
} catch (error) {
  if (error instanceof CircularDependencyError) {
    console.error('Circular dependency:', error.message)
  }
}
```

## Advanced: Formatting Utilities

The library exports formatting utilities for custom output:

```typescript
import { colorize, formatDuration } from 'plantr'

// Colorize text
console.log(colorize('Success!', 'green', 'bold'))

// Format milliseconds
console.log(formatDuration(1234)) // "1.2s"
```

## Seeding State

The library automatically manages seeding state. Use `isSeedingActive` from the instance to check if seeding is running:

```typescript
const { defineSeeder, runSeeders, isSeedingActive } = createSeederInstance({
  context: (base) => ({ ...base, prisma }),
})

// Export for use in your message/queue system
export { isSeedingActive }

// In your job/message handlers:
if (isSeedingActive()) {
  console.log('Skipping side effect during seeding')
  return
}
```

The seeding state is automatically set to `true` before seeders run and `false` after they complete.

## Architecture

```
plantr/
├── index.ts                       # Public exports
└── src/
    ├── types.ts                   # Type definitions (BaseSeederContext, etc.)
    ├── create-seeder-instance.ts  # Factory function
    ├── define-seeder.ts           # Seeder definition
    ├── run-seeders.ts             # Core runner
    ├── dependency-resolver.ts     # Topological sort
    ├── step.ts                    # Step runner with caching
    ├── seeding-state.ts           # Global seeding state
    └── formatting.ts              # Output formatting
```
