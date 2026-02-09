import { colorize } from './formatting'

export type StepOptions = {
	/** Enable caching for this step */
	useCache?: boolean
}

export type StepFn = <T>(
	description: string,
	fn: () => T | Promise<T>,
	options?: StepOptions,
) => Promise<T>

/**
 * Cache interface for step caching.
 * Provide get/set functions to enable caching in the step runner.
 */
export type SeederCache = {
	/** Get a cached value by key. Returns undefined if not found. */
	get: <T>(key: string) => Promise<T | undefined>
	/** Set a cached value by key. */
	set: <T>(key: string, value: T) => Promise<void>
}

type StepRunnerConfig = {
	cache?: SeederCache
	/** Seeder name for scoping cache keys */
	seederName?: string
}

/**
 * Create a step runner for organizing seeder workflow.
 * Optionally provide a cache for step caching support.
 */
export function createStepRunner(config?: StepRunnerConfig): {
	step: StepFn
	/** Set the current seeder name for cache key scoping */
	setSeederName: (name: string) => void
} {
	const { cache } = config ?? {}
	let currentSeederName = config?.seederName ?? ''

	const setSeederName = (name: string): void => {
		currentSeederName = name
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

		try {
			let result: T
			let wasCached = false

			if (useCache && cache) {
				// Try to get from cache
				const cached = await cache.get<T>(cacheKey)
				if (cached !== undefined) {
					result = cached
					wasCached = true
				} else {
					// Execute and cache
					result = await fn()
					await cache.set(cacheKey, result)
				}
			} else if (useCache && !cache) {
				// Warn if caching requested but no cache configured
				console.log(colorize(`    ⚠ Cache not configured, running without cache`, 'yellow'))
				result = await fn()
			} else {
				result = await fn()
			}

			const cacheIndicator = wasCached ? ` ${colorize('(cached)', 'cyan')}` : ''
			console.log(`    ${colorize('✓', 'green')} ${description}${cacheIndicator}`)
			return result
		} catch (error) {
			console.log(`    ${colorize('✗', 'red')} ${description}`)
			if (error instanceof Error) {
				console.log(`        ${colorize(error.message, 'dim')}`)
			}
			throw error
		}
	}

	return { step, setSeederName }
}
