import { resolveDependencyOrder } from './dependency-resolver'
import {
	printErrors,
	printResultsTable,
	printSeederComplete,
	printSeederHeader,
	printSeederSkipped,
	printStartBanner,
	printSummary,
} from './formatting'
import type { RunSeedersOptions, SeederAny, SeederResult } from './types'

/**
 * Internal configuration used by the runner.
 * This is created by createSeederInstance and includes the wrapped context factory.
 */
export type InternalSeederConfig<TContext> = {
	/** Factory function that creates the full context (already includes base context) */
	context: () => TContext | Promise<TContext>
	/** Called before each seeder to set the current seeder name (for cache key scoping) */
	setSeederName?: (name: string) => void
	/** Called before all seeders run */
	onBeforeAll?: () => void | Promise<void>
	/** Called after all seeders complete */
	onAfterAll?: () => void | Promise<void>
}

/**
 * Core seeder runner - executes seeders in dependency order
 *
 * @param seeders - Array of seeders to run
 * @param config - Instance configuration (context factory, lifecycle hooks)
 * @param options - Runner options (verbose output, etc.)
 * @returns Object containing results and success status
 */
export async function runSeedersCore<TContext>(
	seeders: readonly SeederAny[],
	config: InternalSeederConfig<TContext>,
	options: RunSeedersOptions = {},
): Promise<{
	results: SeederResult[]
	success: boolean
}> {
	const { printResults = true, verbose = true, continueOnFailure = false } = options

	// Call onBeforeAll hook
	if (config.onBeforeAll) {
		await config.onBeforeAll()
	}

	if (verbose) {
		printStartBanner()
	}

	// Resolve execution order based on dependencies
	let orderedNames: string[]
	try {
		orderedNames = resolveDependencyOrder(seeders)
	} catch (error) {
		console.error('Failed to resolve seeder dependencies:')
		console.error(`   ${error instanceof Error ? error.message : String(error)}`)
		if (config.onAfterAll) {
			await config.onAfterAll()
		}
		return { results: [], success: false }
	}

	// Create a map for quick seeder lookup
	const seederMap = new Map<string, SeederAny>()
	for (const seeder of seeders) {
		seederMap.set(seeder.name, seeder)
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

		// Set current seeder name for cache key scoping
		if (config.setSeederName) {
			config.setSeederName(name)
		}

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

			if (verbose) {
				printSeederComplete(result.durationMs, true)
			}
		} catch (error) {
			// Update result with error
			result.status = 'failed'
			result.durationMs = Date.now() - startTime
			result.error = error instanceof Error ? error : new Error(String(error))
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

	// Call onAfterAll hook
	if (config.onAfterAll) {
		await config.onAfterAll()
	}

	const failed = results.filter((r) => r.status === 'failed').length
	return { results, success: failed === 0 }
}
