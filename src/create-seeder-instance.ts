import { AsyncLocalStorage } from 'node:async_hooks'
import type { Faker } from '@faker-js/faker'
import { type RunSeedersCliOptions, runCli } from './cli.js'
import { createDefineSeeder } from './define-seeder.js'
import { type AnyExpectFn, type ExpectFn, getDefaultExpect } from './expect.js'
import { getDefaultFaker, lazyFaker } from './lazy-faker.js'
import { type FreshRun, runSeedersCore, type SetupHelpers } from './run-seeders.js'
import { isSeedingActive } from './seeding-state.js'
import { createStepRunner, type SeederCache, type StepRunner } from './step.js'
import type {
	BaseSeederContext,
	MaybePromise,
	Prettify,
	RunSeedersOptions,
	RunSeedersResult,
	Seeder,
	SeederConfig,
	SeederName,
	ValidateSeeders,
} from './types.js'

/** Resolve the effective `expect` type from an optional `config.expect` type parameter */
export type ResolvedExpect<TExpect> = [Exclude<TExpect, undefined>] extends [never]
	? ExpectFn
	: [AnyExpectFn] extends [Exclude<TExpect, undefined>]
		? ExpectFn
		: undefined extends TExpect
			? Exclude<TExpect, undefined> | ExpectFn
			: TExpect

/**
 * Full context type resolved from `BaseSeederContext` plus the extra properties
 * returned by `config.context`. Any base key returned by `context` overrides the default.
 */
export type ResolvedContext<
	TExtra extends object = Record<never, never>,
	TExpect = ExpectFn,
> = Prettify<Omit<BaseSeederContext<ResolvedExpect<TExpect>>, keyof TExtra> & TExtra>

/**
 * Configuration for creating a seeder instance.
 * `context` is optional and its returned properties are automatically merged onto `BaseSeederContext`.
 */
export type SeederInstanceConfig<
	TExtra extends object = Record<never, never>,
	TExpect extends AnyExpectFn | undefined = ExpectFn,
	TResources = undefined,
> = {
	/**
	 * Optional: acquire what the run needs (a database connection, an authenticated client)
	 * and return it. Runs once per run, after the target guard, before the cache and the
	 * context factory, which both receive the returned resources. Throw to refuse the run.
	 *
	 * Register the cleanup for each resource with `defer` right after acquiring it when
	 * `setup` acquires several: if `setup` throws later, the deferred cleanups still run
	 * (last registered first), while `teardown` does not, as there are no resources to pass it.
	 *
	 * @example
	 * ```typescript
	 * setup: async () => {
	 *   const db = await connect(process.env.DATABASE_URL)
	 *   return { db }
	 * },
	 * teardown: ({ db }) => db.close(),
	 * ```
	 */
	setup?: ((helpers: SetupHelpers) => MaybePromise<TResources>) | undefined

	/**
	 * Optional: release what `setup` returned. Runs once whenever `setup` returned: after
	 * the seeders (also when one fails), when the cache or context factory throws, and on
	 * SIGINT or SIGTERM before the process exits. Deferred cleanups run after it.
	 */
	teardown?: ((resources: NoInfer<TResources>) => MaybePromise<void>) | undefined

	/**
	 * Optional factory function that extends the base context (`faker`, `step`, `expect`).
	 * Returned properties are merged onto `base` automatically — no need to spread `...base`,
	 * though spreading or overriding keys (such as `faker`) also works.
	 * Called once per run, after `setup`, with the resources it returned.
	 *
	 * @example
	 * ```typescript
	 * context: (base, { db }) => ({ db })
	 * ```
	 */
	context?:
		| ((
				base: NoInfer<BaseSeederContext<ResolvedExpect<TExpect>>>,
				resources: NoInfer<TResources>,
		  ) => MaybePromise<TExtra>)
		| undefined

	/**
	 * Optional: custom `expect` assertion function (for example Vitest's `expect`).
	 * Defaults to `bun:test`'s `expect` on Bun and a zero-dependency `node:assert/strict`
	 * implementation on Node.js.
	 */
	expect?: TExpect | undefined

	/**
	 * Optional cache for step caching.
	 * Provide `get` / `set` (and optionally `getAll` for single-query preloading), or a
	 * function that builds the cache from the resources `setup` returned. The function runs
	 * once per run, after `setup` and before the cache preload; return `undefined` to run
	 * without a cache.
	 *
	 * @example
	 * ```typescript
	 * cache: {
	 *   get: async (key) => (await prisma.seedCache.findUnique({ where: { key } }))?.output,
	 *   set: async (key, value) => {
	 *     const output = value as Prisma.InputJsonValue
	 *     await prisma.seedCache.upsert({ where: { key }, create: { key, output }, update: { output } })
	 *   },
	 * }
	 * // or, from setup's resources:
	 * cache: ({ db }) => db.seedCache,
	 * ```
	 */
	cache?:
		| SeederCache
		| ((resources: NoInfer<TResources>) => MaybePromise<SeederCache | undefined>)
		| undefined

	/**
	 * Optional: reset the target before a fresh run (CLI `--fresh`, or the `fresh` option),
	 * for example wipe a local emulator, so steps that create records with ids the target
	 * chooses do not create them a second time. Runs after `setup` and the cache factory,
	 * before the cache preload and the context factory, and only when at least one seeder of
	 * the run is fresh. `all` is true only when every registered seeder runs fresh: with
	 * `--fresh` plus seeder names, the seeders they depend on still replay their cache, so
	 * wipe only when `all` is true (or throw to refuse a partial fresh run).
	 *
	 * @example
	 * ```typescript
	 * onFresh: async ({ resources: { db }, all }) => {
	 *   if (all) await db.wipe()
	 * }
	 * ```
	 */
	onFresh?: ((run: FreshRun<NoInfer<TResources>>) => MaybePromise<void>) | undefined

	/**
	 * Optional: default maximum number of independent seeders to run concurrently (default: 1).
	 * Applies to both `runSeeders` and `runSeedersCli` unless overridden per run or via `--concurrency`.
	 * Set to a positive integer (e.g. `4`) or `Infinity` to run independent DAG branches in parallel.
	 */
	concurrency?: number | undefined

	/**
	 * Optional: custom `Faker` instance (e.g. a non-English locale like `fakerDE` or `fakerNB_NO`).
	 * Defaults to the lazy-loaded English locale (`@faker-js/faker/locale/en`).
	 */
	faker?: Faker | undefined

	/**
	 * Optional: the database URL this instance writes to, e.g. `() => process.env.DATABASE_URL`.
	 * The banner prints its host and database (never credentials), and a run refuses a
	 * host that is not local unless it passes `allowRemote` (CLI: `--allow-remote`).
	 * Return undefined to skip the check.
	 */
	target?: (() => string | undefined) | undefined

	/**
	 * Optional: seed faker before each seeder with this number plus a hash of the
	 * seeder's name, so every run generates the same data and adding a seeder does
	 * not shift the others'. Works safely with parallel `concurrency` via isolated Faker instances.
	 */
	fakerSeed?: number | undefined

	/**
	 * Optional, with `fakerSeed`: how finely faker is seeded (default: `'seeder'`).
	 *
	 * - `'seeder'`: one faker per seeder, seeded from `fakerSeed` and the seeder's name. A
	 *   cached step skips its function, and with it the faker draws in it, so everything the
	 *   seeder draws after that step shifts between a cached and an uncached run.
	 * - `'step'`: each step's function also gets its own faker, seeded from `fakerSeed`, the
	 *   seeder's name and the step's `key` (or description), plus a counter when a key repeats.
	 *   Draws inside a step and draws after it are the same whether earlier steps ran or came
	 *   from the cache, and parallel steps no longer share one sequence.
	 *
	 * Switching to `'step'` changes the data steps generate once, which is why it is not the default.
	 */
	fakerSeedScope?: 'seeder' | 'step' | undefined

	/**
	 * Called before all seeders run, before `setup` and the context factory.
	 *
	 * @deprecated Use `setup`: throw from it to refuse a run, and return what it connects
	 * so `teardown`, `context` and a `cache` factory receive it. Still called, before `setup`.
	 *
	 * @example
	 * ```typescript
	 * onBeforeAll: async () => {
	 *   await prisma.$connect()
	 * }
	 * ```
	 */
	onBeforeAll?: (() => MaybePromise<void>) | undefined

	/**
	 * Called after all seeders complete (success or failure), also when the context
	 * factory throws. Receives the created context (or `undefined` if the context factory threw).
	 *
	 * @deprecated Use `teardown`, which receives the resources `setup` returned even when
	 * no context exists. Still called, before `teardown`.
	 *
	 * @example
	 * ```typescript
	 * onAfterAll: async () => {
	 *   await prisma.$disconnect()
	 * }
	 * ```
	 */
	onAfterAll?:
		| ((ctx: NoInfer<ResolvedContext<TExtra, TExpect>> | undefined) => MaybePromise<void>)
		| undefined
}

/**
 * Result type for the seeder instance
 */
export type SeederInstance<TContext extends object = BaseSeederContext> = {
	/**
	 * Define a new seeder with typed dependencies.
	 * `dependsOn` only accepts seeders whose context is compatible with this instance.
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
		const TDeps extends readonly Seeder<TContext, string, unknown, string>[] = readonly [],
	>(
		config: SeederConfig<TContext, TName, TOutput, TDeps>,
	) => Seeder<TContext, TName, Awaited<TOutput>, SeederName<TDeps[number]>>

	/**
	 * Run an array of seeders in dependency order.
	 * Automatically sets seeding state to active during execution.
	 *
	 * - Enforces context compatibility across seeders at compile time
	 * - Flags missing dependencies at compile time when passing known seeders
	 * - Autocompletes and checks `only` and `fresh` against the registered seeder names
	 * - Returns strongly typed `outputs` and discriminated-union `results`
	 *
	 * @param seeders - Array of seeders to run
	 * @param options - Optional runner options
	 * @returns Object containing `success`, typed `results`, and typed `outputs`
	 * @throws Before anything runs, on an invalid registry (duplicate name, missing
	 * dependency, cycle), an unknown name in `only`/`fresh`, invalid `concurrency`, or a refused `target`
	 */
	runSeeders: <
		const TSeeders extends readonly Seeder<TContext, string, unknown, string>[],
		const TOptions extends RunSeedersOptions<SeederName<TSeeders[number]>> | undefined = undefined,
	>(
		seeders: TSeeders & ValidateSeeders<TSeeders>,
		options?: TOptions,
	) => Promise<RunSeedersResult<TSeeders, TOptions>>

	/**
	 * Run seeders as a CLI command: parses the arguments, runs, and exits with 0 or 1.
	 * Seeder names (positional or `--only a,b`) select seeders plus their dependencies;
	 * `--fresh`, `--concurrency`, `--continue-on-failure`, `--allow-remote`, `--quiet`,
	 * `--dry-run`, `--list`, and `--help` map to the runner options. Unknown flags and names exit 1.
	 *
	 * @example
	 * ```typescript
	 * // At the bottom of your seed registry file:
	 * if (import.meta.main) {
	 *   runSeedersCli(seeders)
	 * }
	 * ```
	 */
	runSeedersCli: <const TSeeders extends readonly Seeder<TContext, string, unknown, string>[]>(
		seeders: TSeeders & ValidateSeeders<TSeeders>,
		options?: RunSeedersCliOptions,
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

type FakerConstructor = new (options: { locale: Faker['rawDefinitions'] }) => Faker

/** Create an isolated Faker instance using the same locale definitions as `baseFaker` */
function cloneFaker(baseFaker: Faker): Faker {
	const Ctor = baseFaker.constructor as FakerConstructor | undefined
	if (typeof Ctor === 'function' && 'rawDefinitions' in baseFaker && baseFaker.rawDefinitions) {
		return new Ctor({ locale: baseFaker.rawDefinitions })
	}
	return baseFaker
}

/**
 * Create a seeder instance with an optional custom context.
 *
 * This is the main entry point for the seeder library. The library provides
 * a base context with `faker`, `step`, and `expect`. Consumers can extend it
 * without needing explicit generics or manual `...base` spreads.
 *
 * The seeding state is automatically managed - set to active after validation
 * succeeds and cleared when the run completes.
 *
 * @example
 * ```typescript
 * import { createSeederInstance } from 'plantr'
 *
 * export const { defineSeeder, runSeeders, runSeedersCli } = createSeederInstance({
 *   context: () => ({ prisma }),
 *   target: () => process.env.DATABASE_URL,
 * })
 * ```
 */
type FakerSlot = {
	name: string
	isolated: boolean
	instance?: Faker
}

export function createSeederInstance<
	TExtra extends object = Record<never, never>,
	TExpect extends AnyExpectFn | undefined = ExpectFn,
	TResources = undefined,
>(
	config?: SeederInstanceConfig<TExtra, TExpect, TResources>,
): SeederInstance<ResolvedContext<TExtra, TExpect>> {
	type TContext = ResolvedContext<TExtra, TExpect>

	const defineSeeder = createDefineSeeder<TContext>()
	const customFaker = config?.faker && config.faker !== lazyFaker ? config.faker : undefined
	const resolveBaseFaker = (): Faker => customFaker ?? getDefaultFaker()
	const customExpect = config?.expect
	const fakerSeed = config?.fakerSeed
	const seedPerStep = fakerSeed !== undefined && config?.fakerSeedScope === 'step'
	const defaultConcurrency = config?.concurrency

	const runInternal = async (
		seeders: readonly Seeder<TContext, string, unknown, string>[],
		options?: RunSeedersOptions,
		bannerName?: string,
	) => {
		// One step runner and faker storage per run, so cache keys, duplicate checks, and scopes are
		// isolated. The runner is built after setup, since the cache may come from its resources.
		let stepRunner: StepRunner | undefined
		const requireStepRunner = (): StepRunner => {
			if (!stepRunner) throw new Error('plantr: the step runner is used before setup finished')
			return stepRunner
		}
		const fakerStorage = new AsyncLocalStorage<FakerSlot>()
		const resolveActiveFaker = (): Faker => {
			const slot = fakerStorage.getStore()
			if (!slot) return resolveBaseFaker()
			if (slot.instance) return slot.instance
			const base = resolveBaseFaker()
			if (!slot.isolated) {
				slot.instance = base
				return base
			}
			const cloned = cloneFaker(base)
			if (fakerSeed !== undefined) {
				cloned.seed(fakerSeed + hashName(slot.name))
			}
			slot.instance = cloned
			return cloned
		}

		// Lazy proxy: neither loads faker nor clones per-seeder Faker until a seeder accesses ctx.faker
		const scopedFaker: Faker = new Proxy({} as Faker, {
			get(_target, prop) {
				const active = resolveActiveFaker()
				const value = Reflect.get(active, prop, active)
				return typeof value === 'function' && prop !== 'constructor' ? value.bind(active) : value
			},
			set(_target, prop, value) {
				const active = resolveActiveFaker()
				return Reflect.set(active, prop, value, active)
			},
			has(_target, prop) {
				return Reflect.has(resolveActiveFaker(), prop)
			},
			ownKeys() {
				return Reflect.ownKeys(resolveActiveFaker())
			},
			getOwnPropertyDescriptor(_target, prop) {
				const desc = Reflect.getOwnPropertyDescriptor(resolveActiveFaker(), prop)
				return desc ? { ...desc, configurable: true } : undefined
			},
			getPrototypeOf() {
				return Reflect.getPrototypeOf(resolveActiveFaker())
			},
		})

		const mergedOptions: RunSeedersOptions =
			defaultConcurrency !== undefined && options?.concurrency === undefined
				? { ...options, concurrency: defaultConcurrency }
				: (options ?? {})

		return runSeedersCore(
			seeders,
			{
				prepare: async (resources) => {
					const cache =
						typeof config?.cache === 'function' ? await config.cache(resources) : config?.cache
					stepRunner = createStepRunner({
						cache,
						log: options?.verbose ?? true,
						aroundStep: seedPerStep
							? ({ seederName, key, occurrence }, run) => {
									const name = `${seederName}:${key}${occurrence > 0 ? `#${occurrence}` : ''}`
									return fakerStorage.run({ name, isolated: true }, run)
								}
							: undefined,
					})
				},
				preloadCache: () => stepRunner?.preload(),
				flushCache: () => stepRunner?.flush(),
				context: async (resources) => {
					const base: BaseSeederContext<ResolvedExpect<TExpect>> = {
						faker: scopedFaker,
						step: requireStepRunner().step,
						expect: (customExpect ?? getDefaultExpect()) as ResolvedExpect<TExpect>,
					}
					if (!config?.context) return base as unknown as TContext
					const extra = await config.context(base, resources)
					return extra === base
						? (base as unknown as TContext)
						: ({ ...base, ...extra } as unknown as TContext)
				},
				createSeederScope: ({ name, fresh, concurrent }) => {
					const stepRunner = requireStepRunner()
					const stepScope = stepRunner.createScope({
						seederName: name,
						fresh,
						prefix: concurrent ? name : undefined,
					})
					const slot: FakerSlot = {
						name,
						isolated: fakerSeed !== undefined || concurrent,
					}

					return {
						record: stepScope.record,
						run: <T>(fn: () => Promise<T>) =>
							stepRunner.runWithScope(stepScope, () => fakerStorage.run(slot, fn)),
					}
				},
				bannerName,
				target: config?.target,
				setup: config?.setup,
				onFresh: config?.onFresh,
				teardown: config?.teardown,
				onBeforeAll: config?.onBeforeAll,
				onAfterAll: config?.onAfterAll,
			},
			mergedOptions,
		)
	}

	const runSeeders = ((
		seeders: readonly Seeder<TContext, string, unknown, string>[],
		options?: RunSeedersOptions,
	) => runInternal(seeders, options)) as SeederInstance<TContext>['runSeeders']

	const runSeedersCli: SeederInstance<TContext>['runSeedersCli'] = async (seeders, options) => {
		const bannerName = options?.name ?? 'Seeders'
		const code = await runCli(
			seeders,
			(s, opts) =>
				runInternal(s as readonly Seeder<TContext, string, unknown, string>[], opts, bannerName),
			{
				name: bannerName,
				argv: options?.argv ?? process.argv.slice(2),
				target: config?.target,
				defaultConcurrency,
			},
		)
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
