import { expect } from 'bun:test'
import { faker } from '@faker-js/faker'
import { runCli } from './cli'
import { createDefineSeeder } from './define-seeder'
import { runSeedersCore } from './run-seeders'
import { isSeedingActive, setSeedingActive } from './seeding-state'
import { createStepRunner, type SeederCache } from './step'
import type {
	BaseSeederContext,
	RunSeedersOptions,
	Seeder,
	SeederAny,
	SeederConfig,
	SeederResult,
} from './types'

/**
 * Configuration for creating a seeder instance.
 * The context factory receives the base context (faker, step, expect) and can extend it.
 */
export type SeederInstanceConfig<TContext extends BaseSeederContext> = {
	/**
	 * Factory function that creates the context for each seeder.
	 * Receives the base context (faker, step, expect) and should return the full context.
	 *
	 * @example
	 * ```typescript
	 * context: (base) => ({
	 *   ...base,
	 *   prisma,
	 *   myHelper: () => { ... }
	 * })
	 * ```
	 */
	context: (base: BaseSeederContext) => TContext | Promise<TContext>

	/**
	 * Optional cache for step caching.
	 * Provide get/set functions to enable caching in the step runner.
	 *
	 * @example
	 * ```typescript
	 * cache: {
	 *   get: async (key) => {
	 *     const cached = await prisma.seedCache.findUnique({ where: { key } })
	 *     return cached?.output as T | undefined
	 *   },
	 *   set: async (key, value) => {
	 *     const output = value as Prisma.InputJsonValue
	 *     await prisma.seedCache.upsert({ where: { key }, create: { key, output }, update: { output } })
	 *   }
	 * }
	 * ```
	 */
	cache?: SeederCache

	/**
	 * Optional: the database URL this instance writes to, e.g. `() => process.env.DATABASE_URL`.
	 * The banner prints its host and database (never credentials), and a run refuses a
	 * host that is not local unless it passes `allowRemote` (CLI: `--allow-remote`).
	 * Return undefined to skip the check.
	 */
	target?: () => string | undefined

	/**
	 * Optional: seed faker before each seeder with this number plus a hash of the
	 * seeder's name, so every run generates the same data and adding a seeder does
	 * not shift the others'.
	 */
	fakerSeed?: number

	/**
	 * Called before all seeders run, before the context factory.
	 * Use for setup like connecting to databases, or to refuse a run.
	 *
	 * @example
	 * ```typescript
	 * onBeforeAll: async () => {
	 *   await prisma.$connect()
	 * }
	 * ```
	 */
	onBeforeAll?: () => void | Promise<void>

	/**
	 * Called after all seeders complete (success or failure), also when the context
	 * factory throws.
	 * Use for cleanup like disconnecting from databases.
	 *
	 * @example
	 * ```typescript
	 * onAfterAll: async () => {
	 *   await prisma.$disconnect()
	 * }
	 * ```
	 */
	onAfterAll?: () => void | Promise<void>
}

/**
 * Result type for the seeder instance
 */
export type SeederInstance<TContext extends BaseSeederContext> = {
	/**
	 * Define a new seeder with typed dependencies
	 *
	 * @example
	 * ```typescript
	 * const userSeeder = defineSeeder({
	 *   name: 'userSeeder',
	 *   dependsOn: [orgSeeder],
	 *   run: async (ctx, deps) => {
	 *     const { orgId } = deps.orgSeeder
	 *     // ctx.faker, ctx.step, ctx.expect are always available
	 *     return { userId: 'user-1' }
	 *   }
	 * })
	 * ```
	 */
	defineSeeder: <
		TName extends string,
		TOutput,
		const TDeps extends readonly SeederAny[] = readonly [],
	>(
		config: SeederConfig<TContext, TName, TOutput, TDeps>,
	) => Seeder<TContext, TName, TOutput>

	/**
	 * Run an array of seeders in dependency order.
	 * Automatically sets seeding state to active during execution.
	 *
	 * @param seeders - Array of seeders to run
	 * @param options - Optional runner options
	 * @returns Object containing results and success status; `success` is false when a seeder failed
	 * @throws Before anything runs, on an invalid registry (duplicate name, missing
	 * dependency, cycle), an unknown name in `only`/`fresh`, or a refused `target`
	 */
	runSeeders: (
		seeders: readonly SeederAny[],
		options?: RunSeedersOptions,
	) => Promise<{ results: SeederResult[]; success: boolean }>

	/**
	 * Run seeders as a CLI command: parses the arguments, runs, and exits with 0 or 1.
	 * Seeder names (positional or `--only a,b`) select seeders plus their dependencies;
	 * `--fresh`, `--continue-on-failure`, `--allow-remote`, `--dry-run` and `--help` map
	 * to the runner options. Unknown flags and names exit 1.
	 *
	 * @example
	 * ```typescript
	 * // At the bottom of your seed registry file:
	 * if (import.meta.main) {
	 *   runSeedersCli(seeders)
	 * }
	 * ```
	 */
	runSeedersCli: (
		seeders: readonly SeederAny[],
		options?: {
			name?: string
			/** Arguments to parse (default: `process.argv.slice(2)`) */
			argv?: readonly string[]
		},
	) => Promise<void>

	/**
	 * Check if seeding is currently active.
	 * Use this in your application to skip side effects during seeding.
	 *
	 * @example
	 * ```typescript
	 * if (isSeedingActive()) {
	 *   console.log('Skipping notification during seeding')
	 *   return
	 * }
	 * ```
	 */
	isSeedingActive: () => boolean
}

/**
 * Create a seeder instance with a custom context
 *
 * This is the main entry point for the seeder library. The library provides
 * a base context with faker, step, and expect. Consumers extend this with
 * their own context (e.g. prisma, custom helpers).
 *
 * The seeding state is automatically managed - set to active when runSeeders
 * starts and set to inactive when it completes.
 *
 * @example
 * ```typescript
 * import { createSeederInstance } from 'plantr'
 *
 * type MyContext = BaseSeederContext & { prisma: typeof prisma }
 *
 * const { defineSeeder, runSeeders, isSeedingActive } = createSeederInstance<MyContext>({
 *   context: (base) => ({
 *     ...base,
 *     prisma,
 *   }),
 *   target: () => process.env.DATABASE_URL,
 * })
 *
 * export { defineSeeder, isSeedingActive }
 *
 * // In your message/queue system:
 * if (isSeedingActive()) {
 *   console.log('Skipping side effect during seeding')
 *   return
 * }
 *
 * // Later...
 * await runSeeders([seeder1, seeder2])
 * ```
 */
export function createSeederInstance<TContext extends BaseSeederContext = BaseSeederContext>(
	config: SeederInstanceConfig<TContext>,
): SeederInstance<TContext> {
	const defineSeeder = createDefineSeeder<TContext>()

	const runSeeders = async (
		seeders: readonly SeederAny[],
		options?: RunSeedersOptions,
	): Promise<{ results: SeederResult[]; success: boolean }> => {
		// One step runner per run, so cache keys and duplicate checks are per run
		const { step, setSeederName } = createStepRunner({
			cache: config.cache,
			log: options?.verbose ?? true,
		})
		const { fakerSeed } = config

		setSeedingActive(true)
		try {
			return await runSeedersCore(
				seeders,
				{
					context: () => config.context({ faker, step, expect }),
					beforeSeeder: (name, { fresh }) => {
						if (fakerSeed !== undefined) faker.seed(fakerSeed + hashName(name))
						return setSeederName(name, { fresh })
					},
					target: config.target,
					onBeforeAll: config.onBeforeAll,
					onAfterAll: config.onAfterAll,
				},
				options,
			)
		} finally {
			setSeedingActive(false)
		}
	}

	const runSeedersCli = async (
		seeders: readonly SeederAny[],
		options?: { name?: string; argv?: readonly string[] },
	): Promise<void> => {
		const code = await runCli(seeders, runSeeders, {
			name: options?.name ?? 'Seeders',
			argv: options?.argv ?? process.argv.slice(2),
		})
		process.exit(code)
	}

	return {
		defineSeeder,
		runSeeders,
		runSeedersCli,
		isSeedingActive,
	}
}

/** Small stable string hash (FNV-1a), so a seeder's faker seed depends only on its name */
function hashName(name: string): number {
	let hash = 0x811c9dc5
	for (let i = 0; i < name.length; i++) {
		hash ^= name.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return hash >>> 0
}
