import { resolveDependencyOrder, UnknownSeederError } from './dependency-resolver'
import {
	printErrors,
	printResultsTable,
	printSeederComplete,
	printSeederHeader,
	printSeederSkipped,
	printStartBanner,
	printSummary,
} from './formatting'
import type { StepRecord } from './step'
import type { RunSeedersOptions, SeederAny, SeederResult } from './types'

/**
 * Internal configuration used by the runner.
 * This is created by createSeederInstance and includes the wrapped context factory.
 */
export type InternalSeederConfig<TContext> = {
	/** Factory function that creates the full context; called once, after onBeforeAll */
	context: () => TContext | Promise<TContext>
	/** Called before each seeder runs (cache scoping); may return the record its steps fill */
	beforeSeeder?: (name: string, options: { fresh: boolean }) => StepRecord | undefined
	/** Database URL the run writes to; non-local hosts are refused unless allowRemote */
	target?: () => string | undefined
	/** Called before the context is created */
	onBeforeAll?: () => void | Promise<void>
	/** Called after all seeders complete, also when a seeder or the context factory throws */
	onAfterAll?: () => void | Promise<void>
}

/**
 * Error thrown when a run would write to a database that is not local
 */
export class SeedTargetError extends Error {
	constructor(label: string) {
		super(
			`Refusing to seed ${label}: it is not a local database. Pass allowRemote (CLI: --allow-remote) to seed it on purpose.`,
		)
		this.name = 'SeedTargetError'
	}
}

const isLocalHost = (hostPort: string): boolean => {
	if (hostPort.startsWith('/')) return true // socket directory
	const lower = hostPort.toLowerCase()
	const bracketed = /^\[([^\]]*)\]/.exec(lower)
	const host = bracketed ? (bracketed[1] ?? '') : lower.replace(/:\d+$/, '')
	return (
		host === '::1' ||
		host === '0.0.0.0' ||
		host === 'host.docker.internal' ||
		host.endsWith('.localhost') ||
		/^127\./.test(host) ||
		!/[.:]/.test(host)
	)
}

/**
 * Describe a database URL without its credentials and say whether every host it names
 * is local: loopback, `*.localhost`, `host.docker.internal`, a socket or `file:` path,
 * or a name without a dot (a compose service). A `host=` parameter overrides the
 * URL's host, as libpq does. Hand-parsed so driver formats `URL` rejects still work
 * (several hosts, `sqlserver://host;key=value`, sockets with credentials).
 */
export function describeTarget(target: string): { label: string; local: boolean } {
	if (/^file:/i.test(target)) return { label: target.replace(/[?#].*$/, ''), local: true }
	const scheme = /^[a-z][\w+.-]*:\/\//i.exec(target)
	if (!scheme) return { label: 'a target that is not a URL', local: false }

	const rest = target.slice(scheme[0].length)
	const queryStart = rest.search(/[?#]/)
	const beforeQuery = queryStart === -1 ? rest : rest.slice(0, queryStart)
	const query = queryStart === -1 ? '' : rest.slice(queryStart)
	// Drop credentials: everything up to the last @ before the query
	const authorityAndPath = beforeQuery.slice(beforeQuery.lastIndexOf('@') + 1)
	const [authority = '', path = ''] = authorityAndPath.split(/(?=[/;])/, 2)
	let hosts = authority.split(',').filter(Boolean)
	const hostParam = /[?&;]host=([^&;#]*)/i.exec(`${query}${path.startsWith(';') ? path : ''}`)?.[1]
	if (hostParam) hosts = decodeURIComponent(hostParam).split(',').filter(Boolean)

	const label = `${hosts.join(',') || 'local socket'}${path.startsWith('/') ? path : ''}`
	return { label, local: hosts.every(isLocalHost) }
}

/**
 * Core seeder runner - executes seeders in dependency order
 *
 * @param seeders - Array of seeders to run
 * @param config - Instance configuration (context factory, lifecycle hooks)
 * @param options - Runner options (verbose output, etc.)
 * @returns Object containing results and success status
 * @throws Dependency errors, `UnknownSeederError` and `SeedTargetError`, before any hook runs
 */
export async function runSeedersCore<TContext>(
	seeders: readonly SeederAny[],
	config: InternalSeederConfig<TContext>,
	options: RunSeedersOptions = {},
): Promise<{
	results: SeederResult[]
	success: boolean
}> {
	const {
		printResults = true,
		verbose = true,
		continueOnFailure = false,
		only,
		fresh = false,
		allowRemote = false,
	} = options

	// Validate everything before touching the database
	const orderedNames = resolveDependencyOrder(seeders, only)

	const seederMap = new Map<string, SeederAny>()
	for (const seeder of seeders) {
		seederMap.set(seeder.name, seeder)
	}
	if (Array.isArray(fresh)) {
		for (const name of fresh) {
			if (!seederMap.has(name)) throw new UnknownSeederError(name, [...seederMap.keys()])
		}
	}

	const targetUrl = config.target?.()
	const target = targetUrl ? describeTarget(targetUrl) : undefined
	if (target && !target.local && !allowRemote) {
		throw new SeedTargetError(target.label)
	}

	if (verbose) {
		printStartBanner(target)
	}

	// Initialize results
	const results: SeederResult[] = orderedNames.map((name) => ({
		name,
		status: 'pending',
	}))

	// Store outputs for dependency injection
	const outputs: Record<string, unknown> = {}

	// Track failed seeders to skip their dependents
	const failedSeeders = new Set<string>()

	if (config.onBeforeAll) {
		await config.onBeforeAll()
	}

	try {
		// Create context once for all seeders
		const ctx = await config.context()

		// Execute seeders in order
		for (let i = 0; i < orderedNames.length; i++) {
			const name = orderedNames[i]
			const result = results[i]

			// TypeScript safety - should never happen since we iterate within bounds
			if (!name || !result) continue

			const seeder = seederMap.get(name)
			if (!seeder) continue

			// Check if any dependencies have failed (only relevant when continueOnFailure is true)
			if (continueOnFailure) {
				const hasFailedDep = seeder.dependsOn.some((dep) => failedSeeders.has(dep))
				if (hasFailedDep) {
					result.status = 'skipped'
					failedSeeders.add(name) // Treat skipped as failed for dependency chain
					if (verbose) {
						printSeederHeader(name, i, orderedNames.length, seeder.description)
						printSeederSkipped(seeder.dependsOn.filter((d) => failedSeeders.has(d)))
					}
					continue
				}
			}

			// Print seeder header
			if (verbose) {
				printSeederHeader(name, i, orderedNames.length, seeder.description)
			}

			// Update status to running
			result.status = 'running'

			const record = config.beforeSeeder?.(name, {
				fresh: fresh === true || (Array.isArray(fresh) && fresh.includes(name)),
			})

			// Build dependency outputs for this seeder
			const deps: Record<string, unknown> = {}
			for (const depName of seeder.dependsOn) {
				deps[depName] = outputs[depName]
			}

			const startTime = Date.now()

			try {
				// Run the seeder
				const output = await seeder.run(ctx, deps)

				// Store output for dependents
				outputs[name] = output

				// Update result
				result.status = 'completed'
				result.durationMs = Date.now() - startTime
				result.output = output
				if (record) result.cachedSteps = record.cachedSteps

				if (verbose) {
					printSeederComplete(result.durationMs, true)
				}
			} catch (error) {
				// Update result with error
				result.status = 'failed'
				result.durationMs = Date.now() - startTime
				result.error = error instanceof Error ? error : new Error(String(error))
				if (record) {
					result.cachedSteps = record.cachedSteps
					if (record.failed && record.failed.error === error) result.failedStep = record.failed.step
				}
				failedSeeders.add(name)

				if (verbose) {
					printSeederComplete(result.durationMs, false)
				}

				// Stop execution on failure unless continueOnFailure is true
				if (!continueOnFailure) {
					break
				}
			}
		}

		// Print results table
		if (printResults) {
			printResultsTable(results)
			printErrors(results)
			printSummary(results)
		}
	} finally {
		if (config.onAfterAll) {
			await config.onAfterAll()
		}
	}

	const failed = results.filter((r) => r.status === 'failed').length
	return { results, success: failed === 0 }
}
