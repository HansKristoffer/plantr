import { colorize, formatDuration } from './formatting'

export type StepOptions = {
	/** Enable caching for this step */
	useCache?: boolean
	/**
	 * Any JSON value describing what the step's output depends on (a number you bump,
	 * the data the step writes). A cached entry stored with a different version is a
	 * miss: the step runs again and its entry is overwritten.
	 */
	version?: unknown
}

export type StepFn = <T>(
	description: string,
	fn: () => T | Promise<T>,
	options?: StepOptions,
) => Promise<T>

/**
 * Cache interface for step caching.
 * Provide get/set functions to enable caching in the step runner.
 * plantr stores an envelope object (`{ __plantr: 1, version?, value }`), so `set`
 * always receives an object and `get` should return it as stored.
 */
export type SeederCache = {
	/** Get a cached value by key. Returns undefined if not found. */
	get: <T>(key: string) => Promise<T | undefined>
	/** Set a cached value by key. */
	set: <T>(key: string, value: T) => Promise<void>
}

/** What the steps of the current seeder did, for error reporting */
export type StepRecord = {
	/** Descriptions of the steps whose output came from the cache */
	cachedSteps: string[]
	/** Description and error of the last step that threw */
	failed?: { step: string; error: unknown }
}

type StepRunnerConfig = {
	cache?: SeederCache
	/** Seeder name for scoping cache keys */
	seederName?: string
	/** Print a line per step (default: true) */
	log?: boolean
}

type CacheEntry = { __plantr: 1; version?: string; value?: unknown }

const isCacheEntry = (stored: unknown): stored is CacheEntry =>
	typeof stored === 'object' && stored !== null && (stored as CacheEntry).__plantr === 1

/**
 * Create a step runner for organizing seeder workflow.
 * Optionally provide a cache for step caching support.
 */
export function createStepRunner(config?: StepRunnerConfig): {
	step: StepFn
	/**
	 * Start a seeder: scopes cache keys to its name and returns the record its steps fill.
	 * With `fresh`, its cached steps ignore stored entries and overwrite them.
	 */
	setSeederName: (name: string, options?: { fresh?: boolean }) => StepRecord
} {
	const { cache, log = true } = config ?? {}
	let currentSeederName = config?.seederName ?? ''
	let fresh = false
	let record: StepRecord = { cachedSteps: [] }
	const usedKeys = new Set<string>()

	const setSeederName = (name: string, options?: { fresh?: boolean }): StepRecord => {
		currentSeederName = name
		fresh = options?.fresh ?? false
		record = { cachedSteps: [] }
		return record
	}

	const print = (line: string) => {
		if (log) console.log(line)
	}

	const step: StepFn = async <T>(
		description: string,
		fn: () => T | Promise<T>,
		options?: StepOptions,
	): Promise<T> => {
		const { useCache = false } = options ?? {}

		// Generate cache key from seeder name + description (scoped to avoid collisions)
		const slugifiedDescription = description
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
		const cacheKey = currentSeederName
			? `${currentSeederName}:${slugifiedDescription}`
			: slugifiedDescription
		const startTime = Date.now()

		try {
			let result: T
			let wasCached = false

			if (useCache && cache) {
				if (usedKeys.has(cacheKey)) {
					throw new Error(
						`Step "${description}" uses cache key "${cacheKey}", which another cached step in this run already used. Give each cached step a unique description.`,
					)
				}
				usedKeys.add(cacheKey)
			}

			if (useCache && cache) {
				const version = options?.version === undefined ? undefined : JSON.stringify(options.version)
				const stored = fresh ? undefined : await cache.get<unknown>(cacheKey)
				if (isCacheEntry(stored) && stored.version === version) {
					result = stored.value as T
					wasCached = true
				} else if (stored !== undefined && !isCacheEntry(stored) && version === undefined) {
					// Written by plantr 1.x, which stored the value bare
					result = stored as T
					wasCached = true
				} else {
					result = await fn()
					const entry: CacheEntry =
						version === undefined
							? { __plantr: 1, value: result }
							: { __plantr: 1, version, value: result }
					await cache.set(cacheKey, entry)
				}
			} else if (useCache && !cache) {
				// Warn if caching requested but no cache configured
				print(colorize(`    ⚠ Cache not configured, running without cache`, 'yellow'))
				result = await fn()
			} else {
				result = await fn()
			}

			if (wasCached) record.cachedSteps.push(description)
			const suffix = wasCached
				? ` ${colorize('(cached)', 'cyan')}`
				: ` ${colorize(formatDuration(Date.now() - startTime), 'dim')}`
			print(`    ${colorize('✓', 'green')} ${description}${suffix}`)
			return result
		} catch (error) {
			record.failed = { step: description, error }
			print(`    ${colorize('✗', 'red')} ${description}`)
			if (error instanceof Error) {
				print(`        ${colorize(error.message, 'dim')}`)
			}
			throw error
		}
	}

	return { step, setSeederName }
}
