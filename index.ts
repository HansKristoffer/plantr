/**
 * plantr - Generic seeder library with built-in faker, step, and expect
 *
 * A TypeScript library for Bun and Node.js (>= 22) for creating type-safe database
 * seeders with dependency resolution. The library provides a base context with faker,
 * step, and expect. Consumers extend this with their own context (e.g. prisma, custom helpers).
 *
 * On Bun, `expect` defaults to `bun:test`. On Node.js, `expect` uses a zero-dependency
 * `node:assert/strict` fallback, or you can pass a custom `expect` (e.g. Vitest's) to
 * `createSeederInstance({ expect })`.
 *
 * @example
 * ```typescript
 * import { createSeederInstance } from 'plantr'
 *
 * const { defineSeeder, runSeeders } = createSeederInstance({
 *   context: () => ({ prisma }),
 * })
 *
 * const userSeeder = defineSeeder({
 *   name: 'userSeeder',
 *   run: async ({ faker, step, expect, prisma }) => {
 *     // faker, step, expect are always available from base context
 *     const user = await step('Create user', async () => {
 *       return prisma.user.create({ data: { name: faker.person.fullName() } })
 *     })
 *     expect(user).toBeDefined()
 *     return { userId: user.id }
 *   }
 * })
 *
 * const run = await runSeeders([userSeeder])
 * if (run.success) {
 *   console.log(run.outputs.userSeeder.userId)
 * }
 * ```
 */

// Re-export lazy-loaded English faker (0ms until first access) and runtime-safe expect
export type { Faker } from '@faker-js/faker'
// CLI types
export type { RunSeedersCliOptions } from './src/cli.js'
// Main API
export type {
	ResolvedContext,
	ResolvedExpect,
	SeederInstance,
	SeederInstanceConfig,
} from './src/create-seeder-instance.js'
export { createSeederInstance } from './src/create-seeder-instance.js'
// Utilities (for advanced use cases)
export { createDefineSeeder } from './src/define-seeder.js'
export {
	CircularDependencyError,
	DuplicateSeederError,
	MissingDependencyError,
	resolveDependencyOrder,
	UnknownSeederError,
} from './src/dependency-resolver.js'
export type {
	AnyExpectFn,
	ErrorConstructor,
	ExpectFn,
	ExpectMatchers,
} from './src/expect.js'
export { expect } from './src/expect.js'
export type { ColorName, StyleName } from './src/formatting.js'
export { colorize, formatDuration } from './src/formatting.js'
export { lazyFaker as faker } from './src/lazy-faker.js'
export type {
	InternalSeederConfig,
	SeederScopeHandle,
	TargetDescription,
} from './src/run-seeders.js'
export { describeTarget, runSeedersCore, SeedTargetError } from './src/run-seeders.js'

// Seeding state. Runtime code (job queues, mailers) should import it from 'plantr/state',
// which does not load faker or bun:test.
export { isSeedingActive } from './src/seeding-state.js'

// Step types and cache
export type {
	CacheEntry,
	CacheWrite,
	SeederCache,
	StepFn,
	StepOptions,
	StepRecord,
	StepRunner,
	StepRunnerConfig,
	StepScope,
} from './src/step.js'
export { createStepRunner } from './src/step.js'

// Types
export type {
	BaseSeederContext,
	CompletedSeederResult,
	DepsFromSeeders,
	FailedSeederResult,
	JsonPrimitive,
	JsonValue,
	MaybePromise,
	MissingSeederDeps,
	PendingSeederResult,
	Prettify,
	RunSeedersOptions,
	RunSeedersResult,
	Seeder,
	SeederAny,
	SeederConfig,
	SeederDeps,
	SeederName,
	SeederOutput,
	SeederOutputs,
	SeederResult,
	SeederResultFor,
	SeederStatus,
	SkippedSeederResult,
	ValidateSeeders,
} from './src/types.js'
