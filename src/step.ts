import { AsyncLocalStorage } from 'node:async_hooks'
import { colorize, formatDuration } from './formatting.js'
import type { JsonValue, MaybePromise } from './types.js'

/** Envelope written to `SeederCache.set` / `SeederCache.setMany` by plantr */
export type CacheEntry = {
	readonly __plantr: 1
	readonly version?: string
	readonly value?: unknown
}

/** Single entry passed to `SeederCache.setMany` */
export type CacheWrite = {
	readonly key: string
	readonly value: CacheEntry
}

export type StepOptions =
	| {
			/** Enable caching for this step */
			useCache?: false | undefined
			version?: never
			key?: never
	  }
	| {
			/** Enable caching for this step */
			useCache: true
			/**
			 * Optional explicit cache key (scoped to the seeder name).
			 * Defaults to a slugified version of the step description.
			 * Use this when you want to reword a description without busting the cache,
			 * or when the description contains non-ASCII characters.
			 */
			key?: string | undefined
			/**
			 * Any JSON value describing what the step's output depends on (a number you bump,
			 * the data the step writes). A cached entry stored with a different version is a
			 * miss: the step runs again and its entry is overwritten. Object keys are compared
			 * deterministically regardless of insertion order.
			 */
			version?: JsonValue | undefined
	  }

export type StepFn = <T>(
	description: string,
	fn: () => MaybePromise<T>,
	options?: StepOptions,
) => Promise<T>

/**
 * Cache interface for step caching.
 * Provide `get` / `set` functions to enable caching in the step runner.
 * plantr stores an envelope object (`{ __plantr: 1, version?, value }`), so `set`
 * always receives a `CacheEntry` and `get` should return it as stored (or `undefined`/`null` on miss).
 *
 * Optionally provide `getAll` to preload all entries in one query at the start of a run,
 * and `setMany` to flush new/updated entries in one batch write at the end of a run.
 */
export type SeederCache = {
	/** Get a cached value by key. Return undefined or null if not found. */
	get: (key: string) => MaybePromise<unknown>
	/** Set a cached value by key. */
	set: (key: string, value: CacheEntry) => MaybePromise<void>
	/**
	 * Optional: load all cached entries once at the start of a run to avoid N+1 `get` queries.
	 */
	getAll?: (() => MaybePromise<Map<string, unknown> | Record<string, unknown>>) | undefined
	/**
	 * Optional: write all new/updated cache entries in a single batch at the end of a run
	 * (before `onAfterAll`), removing per-step write round-trips from the critical path.
	 */
	setMany?: ((entries: readonly CacheWrite[]) => MaybePromise<void>) | undefined
}

/** What the steps of the current seeder did, for error reporting */
export type StepRecord = {
	/** Descriptions of the steps whose output came from the cache */
	cachedSteps: string[]
	/** Description and error of the innermost step that threw */
	failed?: { step: string; error: unknown }
}

/** Isolated execution scope for a single seeder's steps (concurrency-safe) */
export type StepScope = {
	seederName: string
	fresh: boolean
	record: StepRecord
	prefix?: string | undefined
	/** How many steps per key this seeder started, so a repeated key gets its own identity */
	keyCounts?: Map<string, number> | undefined
}

/** Identifies one step run, for `StepRunnerConfig.aroundStep` */
export type StepIdentity = {
	seederName: string
	/** The step's explicit `key`, or else its description */
	key: string
	/** How many earlier steps of this seeder used the same key in this run (0 for the first) */
	occurrence: number
}

export type StepRunnerConfig = {
	cache?: SeederCache | undefined
	/** Seeder name for scoping cache keys */
	seederName?: string | undefined
	/** Print a line per step (default: true) */
	log?: boolean | undefined
	/**
	 * Wraps each run of a step's function (not cache hits), for example to give the step
	 * its own seeded faker. Must call `run` once and return its result.
	 */
	aroundStep?: (<T>(step: StepIdentity, run: () => MaybePromise<T>) => MaybePromise<T>) | undefined
}

export type StepRunner = {
	step: StepFn
	/**
	 * Start a seeder in sequential mode: scopes cache keys to its name and returns the
	 * record its steps fill. With `fresh`, its cached steps ignore stored entries and overwrite them.
	 */
	setSeederName: (name: string, options?: { fresh?: boolean }) => StepRecord
	/** Create an isolated scope for running one seeder concurrently */
	createScope: (options: { seederName: string; fresh?: boolean; prefix?: string }) => StepScope
	/** Run an async callback with `scope` bound via AsyncLocalStorage */
	runWithScope: <T>(scope: StepScope, fn: () => Promise<T>) => Promise<T>
	/** Preload cache entries via `cache.getAll()` if configured */
	preload: () => Promise<void>
	/** Flush buffered cache writes via `cache.setMany()` if configured */
	flush: () => Promise<void>
}

const isCacheEntry = (stored: unknown): stored is CacheEntry =>
	typeof stored === 'object' && stored !== null && (stored as CacheEntry).__plantr === 1

const slugify = (description: string): string =>
	description
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')

/** Canonical JSON stringify with sorted object keys so version comparisons are order-independent */
function canonicalStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => (item === undefined ? 'null' : canonicalStringify(item))).join(',')}]`
	}
	if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
		return canonicalStringify((value as { toJSON: () => unknown }).toJSON())
	}
	const obj = value as Record<string, unknown>
	const keys = Object.keys(obj).sort()
	const parts: string[] = []
	for (const key of keys) {
		const entryValue = obj[key]
		if (entryValue !== undefined) {
			parts.push(`${JSON.stringify(key)}:${canonicalStringify(entryValue)}`)
		}
	}
	return `{${parts.join(',')}}`
}

/**
 * Create a step runner for organizing seeder workflow.
 * Optionally provide a cache for step caching support.
 */
export function createStepRunner(config?: StepRunnerConfig): StepRunner {
	const { cache, log = true, aroundStep } = config ?? {}
	const scopeStorage = new AsyncLocalStorage<StepScope>()
	let fallbackScope: StepScope = {
		seederName: config?.seederName ?? '',
		fresh: false,
		record: { cachedSteps: [] },
	}
	const usedKeys = new Set<string>()
	const pendingWrites = new Map<string, CacheEntry>()
	let preloaded: Map<string, unknown> | undefined
	let warnedNoCache = false

	const setSeederName = (name: string, options?: { fresh?: boolean }): StepRecord => {
		const record: StepRecord = { cachedSteps: [] }
		fallbackScope = {
			seederName: name,
			fresh: options?.fresh ?? false,
			record,
		}
		return record
	}

	const createScope = (options: {
		seederName: string
		fresh?: boolean
		prefix?: string
	}): StepScope => ({
		seederName: options.seederName,
		fresh: options.fresh ?? false,
		record: { cachedSteps: [] },
		prefix: options.prefix,
	})

	const runWithScope = <T>(scope: StepScope, fn: () => Promise<T>): Promise<T> =>
		scopeStorage.run(scope, fn)

	const preload = async (): Promise<void> => {
		if (!cache?.getAll) return
		const entries = await cache.getAll()
		preloaded = entries instanceof Map ? new Map(entries) : new Map(Object.entries(entries))
	}

	const flush = async (): Promise<void> => {
		if (!cache?.setMany || pendingWrites.size === 0) return
		const entries: CacheWrite[] = [...pendingWrites.entries()].map(([key, value]) => ({
			key,
			value,
		}))
		pendingWrites.clear()
		await cache.setMany(entries)
	}

	const print = (line: string) => {
		if (log) console.log(line)
	}

	const formatPrefix = (scope: StepScope): string =>
		scope.prefix ? `  ${colorize(`[${scope.prefix}]`, 'cyan')} ` : '    '

	const step: StepFn = async <T>(
		description: string,
		fn: () => MaybePromise<T>,
		options?: StepOptions,
	): Promise<T> => {
		const scope = scopeStorage.getStore() ?? fallbackScope
		const useCache = options?.useCache === true
		const startTime = performance.now()
		const prefix = formatPrefix(scope)

		// Counted before any await, so steps started together (Promise.all) number in call order
		const identityKey = options?.key ?? description
		scope.keyCounts ??= new Map()
		const occurrence = scope.keyCounts.get(identityKey) ?? 0
		scope.keyCounts.set(identityKey, occurrence + 1)
		const run = (): MaybePromise<T> =>
			aroundStep
				? aroundStep({ seederName: scope.seederName, key: identityKey, occurrence }, fn)
				: fn()

		try {
			let result: T
			let wasCached = false

			if (useCache && cache) {
				const rawKey = options.key !== undefined ? options.key : slugify(description)
				const cacheKey = scope.seederName ? `${scope.seederName}:${rawKey}` : rawKey

				if (usedKeys.has(cacheKey)) {
					throw new Error(
						`Step "${description}" uses cache key "${cacheKey}", which another cached step in this run already used. Give each cached step a unique description or explicit key.`,
					)
				}
				usedKeys.add(cacheKey)

				const version =
					options.version === undefined ? undefined : canonicalStringify(options.version)
				const stored = scope.fresh
					? undefined
					: preloaded !== undefined
						? preloaded.get(cacheKey)
						: await cache.get(cacheKey)

				if (isCacheEntry(stored) && stored.version === version) {
					result = stored.value as T
					wasCached = true
				} else if (
					stored !== undefined &&
					stored !== null &&
					!isCacheEntry(stored) &&
					version === undefined
				) {
					// Written by plantr 1.x, which stored the value bare
					result = stored as T
					wasCached = true
				} else {
					result = await run()
					const entry: CacheEntry =
						version === undefined
							? { __plantr: 1, value: result }
							: { __plantr: 1, version, value: result }
					preloaded?.set(cacheKey, entry)
					if (cache.setMany) {
						pendingWrites.set(cacheKey, entry)
					} else {
						await cache.set(cacheKey, entry)
					}
				}
			} else if (useCache && !cache) {
				if (!warnedNoCache) {
					warnedNoCache = true
					print(`${prefix}${colorize('⚠ Cache not configured, running without cache', 'yellow')}`)
				}
				result = await run()
			} else {
				result = await run()
			}

			if (wasCached) scope.record.cachedSteps.push(description)
			const suffix = wasCached
				? ` ${colorize('(cached)', 'cyan')}`
				: ` ${colorize(formatDuration(performance.now() - startTime), 'dim')}`
			print(`${prefix}${colorize('✓', 'green')} ${description}${suffix}`)
			return result
		} catch (error) {
			// Preserve the innermost failing step if steps are nested
			if (!scope.record.failed || scope.record.failed.error !== error) {
				scope.record.failed = { step: description, error }
			}
			print(`${prefix}${colorize('✗', 'red')} ${description}`)
			if (error instanceof Error) {
				print(`${prefix}    ${colorize(error.message, 'dim')}`)
			}
			throw error
		}
	}

	return { step, setSeederName, createScope, runWithScope, preload, flush }
}
