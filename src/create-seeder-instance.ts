import { expect } from 'bun:test'
import { faker } from '@faker-js/faker'
import { createDefineSeeder } from './define-seeder'
import { resolveDependencyOrder } from './dependency-resolver'
import { colorize } from './formatting'
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
	 *     await prisma.seedCache.create({ data: { key, output: value } })
	 *   }
	 * }
	 * ```
	 */
	cache?: SeederCache

	/**
	 * Called before all seeders run.
	 * Use for setup like connecting to databases.
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
	 * Called after all seeders complete (success or failure).
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
	 * @returns Object containing results and success status
	 */
	runSeeders: (
		seeders: readonly SeederAny[],
		options?: RunSeedersOptions,
	) => Promise<{ results: SeederResult[]; success: boolean }>

	/**
	 * Run seeders as a CLI command.
	 * Handles help flag, prints banner, runs seeders, and exits with proper code.
	 *
	 * @example
	 * ```typescript
	 * // At the bottom of your seed registry file:
	 * if (import.meta.main) {
	 *   runSeedersCli(seeders)
	 * }
	 * ```
	 */
	runSeedersCli: (seeders: readonly SeederAny[], options?: { name?: string }) => Promise<void>

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
 *   cache: {
 *     get: async (key) => {
 *       const cached = await prisma.seedCache.findUnique({ where: { key } })
 *       return cached?.output
 *     },
 *     set: async (key, value) => {
 *       await prisma.seedCache.create({ data: { key, output: value } })
 *     }
 *   },
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
		// Create context once per run (not per seeder)
		const { step, setSeederName } = createStepRunner({ cache: config.cache })
		const baseContext: BaseSeederContext = {
			faker,
			step,
			expect,
		}
		const ctx = await config.context(baseContext)

		// Internal config for the runner
		const internalConfig = {
			context: (): TContext => ctx,
			setSeederName,
			// Automatically manage seeding state
			onBeforeAll: async () => {
				setSeedingActive(true)
				if (config.onBeforeAll) {
					await config.onBeforeAll()
				}
			},
			onAfterAll: async () => {
				setSeedingActive(false)
				if (config.onAfterAll) {
					await config.onAfterAll()
				}
			},
		}

		return runSeedersCore(seeders, internalConfig, options)
	}

	/**
	 * Run seeders as a CLI command.
	 * Handles help flag, dry-run flag, prints banner with seeder count, runs seeders, and exits with proper code.
	 *
	 * @param seeders - Array of seeders to run
	 * @param options - Optional CLI options
	 */
	const runSeedersCli = async (
		seeders: readonly SeederAny[],
		options?: { name?: string },
	): Promise<void> => {
		const args = process.argv.slice(2)
		const name = options?.name ?? 'Seeders'

		// Show help if requested
		if (args.includes('--help') || args.includes('-h')) {
			console.log(`
${colorize('Usage:', 'cyan', 'bold')} bun run seed [options]

${colorize('Options:', 'white', 'bold')}
  --help, -h     Show this help message
  --dry-run      Show execution order without running seeders

Runs all ${seeders.length} seeders in dependency order.
`)
			process.exit(0)
		}

		// Dry run: show execution order without running
		if (args.includes('--dry-run')) {
			console.log(
				`\n${colorize('🌱 Dry Run', 'cyan', 'bold')} ${colorize(`(${seeders.length} seeders)`, 'dim')}\n`,
			)

			// Create a map for quick seeder lookup
			const seederMap = new Map<string, SeederAny>()
			for (const seeder of seeders) {
				seederMap.set(seeder.name, seeder)
			}

			try {
				const order = resolveDependencyOrder(seeders)
				console.log(colorize('Execution order:', 'white', 'bold'))
				for (let i = 0; i < order.length; i++) {
					const seederName = order[i]
					if (!seederName) continue
					const seeder = seederMap.get(seederName)
					const deps = seeder?.dependsOn ?? []
					const depsStr =
						deps.length > 0 ? ` ${colorize(`(depends on: ${deps.join(', ')})`, 'dim')}` : ''
					console.log(`  ${i + 1}. ${seederName}${depsStr}`)
				}
				console.log('')
				process.exit(0)
			} catch (error) {
				console.error(colorize('Failed to resolve dependencies:', 'red'))
				console.error(`  ${error instanceof Error ? error.message : String(error)}`)
				process.exit(1)
			}
		}

		console.log(
			`\n${colorize(`🌱 Running ${name}`, 'cyan', 'bold')} ${colorize(`(${seeders.length} seeders)`, 'dim')}\n`,
		)
		const { success } = await runSeeders(seeders, {
			printResults: true,
			verbose: true,
		})
		process.exit(success ? 0 : 1)
	}

	return {
		defineSeeder,
		runSeeders,
		runSeedersCli,
		isSeedingActive,
	}
}
