/**
 * plantr - Generic seeder library with built-in faker, step, and expect
 *
 * A Bun-first library for creating type-safe database seeders with dependency resolution.
 * The library provides a base context with faker, step, and expect. Consumers
 * extend this with their own context (e.g. prisma, custom helpers).
 *
 * Note: This library requires Bun as it uses bun:test for the expect function.
 *
 * @example
 * ```typescript
 * import { createSeederInstance, type BaseSeederContext } from 'plantr'
 *
 * type MyContext = BaseSeederContext & { prisma: typeof prisma }
 *
 * const { defineSeeder, runSeeders } = createSeederInstance<MyContext>({
 *   context: (base) => ({
 *     ...base,
 *     prisma,
 *   }),
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
 * await runSeeders([userSeeder])
 * ```
 */

// Re-export faker and expect for convenience
export { expect } from 'bun:test'
export { faker } from '@faker-js/faker'

// Main API
export type { SeederInstance, SeederInstanceConfig } from './src/create-seeder-instance'
export { createSeederInstance } from './src/create-seeder-instance'

// Utilities (for advanced use cases)
export { createDefineSeeder } from './src/define-seeder'
export {
	CircularDependencyError,
	MissingDependencyError,
	resolveDependencyOrder,
} from './src/dependency-resolver'
export { colorize, formatDuration } from './src/formatting'
export { runSeedersCore } from './src/run-seeders'

// Seeding state (for advanced use cases - prefer using isSeedingActive from the instance)
export { isSeedingActive } from './src/seeding-state'

// Step types and cache
export type { SeederCache, StepFn, StepOptions } from './src/step'
export { createStepRunner } from './src/step'

// Types
export type {
	BaseSeederContext,
	DepsFromSeeders,
	RunSeedersOptions,
	Seeder,
	SeederAny,
	SeederConfig,
	SeederName,
	SeederOutput,
	SeederResult,
	SeederStatus,
} from './src/types'
