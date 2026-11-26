/**
 * Generic seeder types - context-agnostic
 *
 * The library provides a base context with faker, step, and expect.
 * Consumers can extend this with their own context (e.g. prisma, custom helpers).
 */

import type { Faker } from '@faker-js/faker'
import type { ExpectFn } from './expect.js'
import type { StepFn } from './step.js'

/** Flatten intersections and mapped types for cleaner IDE hover tooltips */
export type Prettify<T> = { [K in keyof T]: T[K] } & {}

/** A value or a Promise resolving to that value */
export type MaybePromise<T> = T | Promise<T>

/** JSON-serializable primitive */
export type JsonPrimitive = string | number | boolean | null

/** JSON-serializable value (used for step cache versions) */
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue | undefined }

/**
 * Base seeder context provided by the library.
 * Contains faker for generating test data, step for workflow organization,
 * and expect for assertions.
 */
export type BaseSeederContext<TExpect = ExpectFn> = {
	/** Faker instance for generating test data */
	faker: Faker
	/** Step function for organizing seeder workflow */
	step: StepFn
	/** Assertion function for verifying data (bun:test on Bun, built-in fallback on Node, or custom) */
	expect: TExpect
}

/** Extract the output type from a Seeder */
// biome-ignore lint/suspicious/noExplicitAny: needs any to match any context type
export type SeederOutput<T> = T extends Seeder<any, any, infer O, any> ? O : never

/** Extract the name from a Seeder */
// biome-ignore lint/suspicious/noExplicitAny: needs any to match any context type
export type SeederName<T> = T extends Seeder<any, infer N, any, any> ? N : never

/** Extract the dependency names from a Seeder */
// biome-ignore lint/suspicious/noExplicitAny: needs any to match any context type
export type SeederDeps<T> = T extends Seeder<any, any, any, infer D> ? D : never

/** Build a typed deps object from an array of seeder dependencies */
export type DepsFromSeeders<T extends readonly SeederAny[]> = Prettify<{
	[K in T[number] as SeederName<K>]: SeederOutput<K>
}>

/** Map of seeder name -> output type for a collection of seeders */
export type SeederOutputs<TSeeders extends readonly SeederAny[]> = Prettify<{
	[K in TSeeders[number] as SeederName<K>]: SeederOutput<K>
}>

/**
 * Dependency names required by seeders in `TSeeders` that are not present in `TSeeders`.
 * Evaluates to `never` when all dependencies are present or when names are widened to `string`.
 */
export type MissingSeederDeps<TSeeders extends readonly SeederAny[]> = string extends SeederName<
	TSeeders[number]
>
	? never
	: string extends SeederDeps<TSeeders[number]>
		? never
		: Exclude<SeederDeps<TSeeders[number]>, SeederName<TSeeders[number]>>

/**
 * Compile-time constraint verifying that every dependency declared by a seeder in `TSeeders`
 * is also included in `TSeeders`.
 */
export type ValidateSeeders<TSeeders extends readonly SeederAny[]> = [
	MissingSeederDeps<TSeeders>,
] extends [never]
	? unknown
	: {
			readonly __missingDependencies__: `Missing required seeder(s) in list: ${MissingSeederDeps<TSeeders>}`
		}

/** Configuration for creating a seeder */
export type SeederConfig<
	TContext,
	TName extends string,
	TOutput,
	TDeps extends readonly SeederAny[] = readonly [],
> = {
	/** Unique name for the seeder */
	name: TName
	/** Optional description of what the seeder does */
	description?: string | undefined
	/** Seeder objects that must run before this one - provides typed outputs */
	dependsOn?: TDeps | undefined
	/** The seeding function that creates data (sync or async) */
	run: (
		ctx: TContext,
		deps: TDeps extends readonly never[] ? Record<string, never> : DepsFromSeeders<TDeps>,
	) => MaybePromise<TOutput>
}

/** A seeder instance ready for execution */
export type Seeder<
	TContext,
	TName extends string = string,
	TOutput = unknown,
	TDepNames extends string = string,
> = {
	/** Unique name for the seeder */
	readonly name: TName
	/** Optional description of what the seeder does */
	readonly description?: string | undefined
	/** Names of seeders that must run before this one (extracted from dependsOn) */
	readonly dependsOn: readonly TDepNames[]
	/** The seeding function that creates data */
	readonly run: (ctx: TContext, deps: Record<string, unknown>) => MaybePromise<TOutput>
}

/** Type-erased seeder for collections (can hold any seeder type) */
// biome-ignore lint/suspicious/noExplicitAny: SeederAny needs 'any' to work without explicit context type
export type SeederAny = Seeder<any, string, unknown, string>

/** Result for a seeder that completed successfully */
export type CompletedSeederResult<TName extends string = string, TOutput = unknown> = {
	name: TName
	status: 'completed'
	durationMs: number
	output: TOutput
	/** Descriptions of the steps whose output came from the cache */
	cachedSteps: string[]
}

/** Result for a seeder that threw an error */
export type FailedSeederResult<TName extends string = string> = {
	name: TName
	status: 'failed'
	durationMs: number
	error: Error
	/** Description of the step that threw, when the seeder failed in a step */
	failedStep?: string | undefined
	/** Descriptions of the steps whose output came from the cache */
	cachedSteps: string[]
}

/** Result for a seeder that was skipped because one or more dependencies failed */
export type SkippedSeederResult<TName extends string = string> = {
	name: TName
	status: 'skipped'
	/** Names of direct dependencies that failed or were skipped */
	failedDeps: string[]
}

/** Result for a seeder that never started (e.g. an earlier seeder failed without continueOnFailure) */
export type PendingSeederResult<TName extends string = string> = {
	name: TName
	status: 'pending'
}

/** Discriminated union representing the outcome of a seeder */
export type SeederResult<TName extends string = string, TOutput = unknown> =
	| CompletedSeederResult<TName, TOutput>
	| FailedSeederResult<TName>
	| SkippedSeederResult<TName>
	| PendingSeederResult<TName>

/** Status of a seeder result */
export type SeederStatus = SeederResult['status']

/**
 * Union of typed `SeederResult` members pairing each seeder in `TSeeders`
 * with its literal name and output type.
 */
export type SeederResultFor<TSeeders extends readonly SeederAny[]> =
	TSeeders[number] extends infer S
		? S extends SeederAny
			? SeederResult<SeederName<S>, SeederOutput<S>>
			: never
		: never

/** Options for the seeder runner */
export type RunSeedersOptions<TName extends string = string> = {
	/** Whether to print the results table (default: true) */
	printResults?: boolean | undefined
	/** Whether to print verbose output (default: true) */
	verbose?: boolean | undefined
	/**
	 * Whether to continue running seeders after a failure (default: false).
	 * When true, seeders that depend on a failed seeder will be skipped,
	 * but independent seeders will still run.
	 */
	continueOnFailure?: boolean | undefined
	/**
	 * Run only these seeders and everything they depend on, in dependency order.
	 * Throws `UnknownSeederError` for a name that is not registered.
	 */
	only?: readonly TName[] | undefined
	/**
	 * Ignore cached step entries and overwrite them: `true` for every seeder,
	 * or the names of the seeders to run fresh. Dependencies of those seeders still
	 * replay their cache unless they are named too.
	 */
	fresh?: boolean | readonly TName[] | undefined
	/**
	 * Seed a target that is not local (see `target` on the instance config).
	 * Without it, a non-local target throws `SeedTargetError` before anything runs.
	 */
	allowRemote?: boolean | undefined
	/**
	 * Maximum number of independent seeders to run concurrently (default: 1).
	 * Set to a positive integer (e.g. `4`) or `Infinity` to run independent DAG branches in parallel.
	 */
	concurrency?: number | undefined
	/**
	 * Handle SIGINT and SIGTERM while the run is active (default: true): start no more
	 * seeders, flush the cache, run `onAfterAll`, `teardown` and deferred cleanups, then
	 * exit with 130 (SIGINT) or 143 (SIGTERM). A second signal exits at once. Set to
	 * `false` when your own signal handlers should stay in charge.
	 */
	handleSignals?: boolean | undefined
}

type OutputsOnSuccess<TSeeders extends readonly SeederAny[], TOptions> = [TOptions] extends [
	undefined,
]
	? SeederOutputs<TSeeders>
	: TOptions extends { readonly only: readonly (infer TOnly extends string)[] }
		? string extends TOnly
			? Partial<SeederOutputs<TSeeders>>
			: Prettify<
					Pick<SeederOutputs<TSeeders>, Extract<TOnly, keyof SeederOutputs<TSeeders>>> &
						Partial<SeederOutputs<TSeeders>>
				>
		: TOptions extends { readonly only?: readonly string[] | undefined }
			? 'only' extends keyof TOptions
				? Partial<SeederOutputs<TSeeders>>
				: SeederOutputs<TSeeders>
			: SeederOutputs<TSeeders>

/** Return value of `runSeeders` with typed `results` and `outputs` */
export type RunSeedersResult<
	TSeeders extends readonly SeederAny[] = readonly SeederAny[],
	TOptions = undefined,
> =
	| {
			success: true
			results: SeederResultFor<TSeeders>[]
			outputs: OutputsOnSuccess<TSeeders, TOptions>
	  }
	| {
			success: false
			results: SeederResultFor<TSeeders>[]
			outputs: Partial<SeederOutputs<TSeeders>>
	  }
