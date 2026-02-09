/**
 * Generic seeder types - context-agnostic
 *
 * The library provides a base context with faker, step, and expect.
 * Consumers can extend this with their own context (e.g. prisma, custom helpers).
 */

import type { expect } from 'bun:test'
import type { faker } from '@faker-js/faker'
import type { StepFn } from './step'

/**
 * Base seeder context provided by the library.
 * Contains faker for generating test data, step for workflow organization,
 * and expect for assertions.
 */
export type BaseSeederContext = {
	/** Faker instance for generating test data */
	faker: typeof faker
	/** Step function for organizing seeder workflow */
	step: StepFn
	/** Assertion function from bun:test for verifying data */
	expect: typeof expect
}

/** Extract the output type from a Seeder */
// biome-ignore lint/suspicious/noExplicitAny: needs any to match any context type
export type SeederOutput<T> = T extends Seeder<any, string, infer O> ? O : never

/** Extract the name from a Seeder */
// biome-ignore lint/suspicious/noExplicitAny: needs any to match any context type
export type SeederName<T> = T extends Seeder<any, infer N, unknown> ? N : never

/** Build a typed deps object from an array of seeder dependencies */
export type DepsFromSeeders<T extends readonly SeederAny[]> = {
	[K in T[number] as SeederName<K>]: SeederOutput<K>
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
	description?: string
	/** Seeder objects that must run before this one - provides typed outputs */
	dependsOn?: TDeps
	/** The seeding function that creates data */
	run: (
		ctx: TContext,
		deps: TDeps extends readonly never[] ? Record<string, never> : DepsFromSeeders<TDeps>,
	) => Promise<TOutput>
}

/** A seeder instance ready for execution */
export type Seeder<TContext, TName extends string = string, TOutput = unknown> = {
	/** Unique name for the seeder */
	name: TName
	/** Optional description of what the seeder does */
	description?: string
	/** Names of seeders that must run before this one (extracted from dependsOn) */
	dependsOn: readonly string[]
	/** The seeding function that creates data */
	run: (ctx: TContext, deps: Record<string, unknown>) => Promise<TOutput>
}

/** Type-erased seeder for collections (can hold any seeder type) */
// biome-ignore lint/suspicious/noExplicitAny: SeederAny needs 'any' to work without explicit context type
export type SeederAny = Seeder<any, string, unknown>

/** Status of a seeder execution */
export type SeederStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

/** Result of running a seeder */
export type SeederResult = {
	name: string
	status: SeederStatus
	durationMs?: number
	output?: unknown
	error?: Error
}

/** Options for the seeder runner */
export type RunSeedersOptions = {
	/** Whether to print the results table (default: true) */
	printResults?: boolean
	/** Whether to print verbose output (default: true) */
	verbose?: boolean
	/**
	 * Whether to continue running seeders after a failure (default: false).
	 * When true, seeders that depend on a failed seeder will be skipped,
	 * but independent seeders will still run.
	 */
	continueOnFailure?: boolean
}
