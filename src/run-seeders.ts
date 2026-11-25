import { resolveDependencyOrder, UnknownSeederError } from './dependency-resolver.js'
import {
	printConcurrentComplete,
	printConcurrentSkipped,
	printErrors,
	printResultsTable,
	printSeederComplete,
	printSeederHeader,
	printSeederSkipped,
	printStartBanner,
	printSummary,
} from './formatting.js'
import { enterSeeding, exitSeeding } from './seeding-state.js'
import type { StepRecord } from './step.js'
import type {
	MaybePromise,
	RunSeedersOptions,
	RunSeedersResult,
	SeederAny,
	SeederResult,
	SeederResultFor,
} from './types.js'

/** Parsed description of a database target URL (without credentials) */
export type TargetDescription = {
	label: string
	local: boolean
}

/** Per-seeder scope handle returned by `InternalSeederConfig.runSeederScope` */
export type SeederScopeHandle = {
	record?: StepRecord | undefined
	run: <T>(fn: () => Promise<T>) => Promise<T>
}

/**
 * Internal configuration used by the runner.
 * This is created by `createSeederInstance` and includes the wrapped context factory.
 */
export type InternalSeederConfig<TContext> = {
	/** Factory function that creates the full context; called once, after onBeforeAll */
	context: () => MaybePromise<TContext>
	/** Called once after onBeforeAll to preload step cache entries (when cache.getAll is configured) */
	preloadCache?: (() => MaybePromise<void>) | undefined
	/** Called once before onAfterAll to flush buffered step cache writes (when cache.setMany is configured) */
	flushCache?: (() => MaybePromise<void>) | undefined
	/** Called before each seeder runs (legacy sequential hook); may return the record its steps fill */
	beforeSeeder?: ((name: string, options: { fresh: boolean }) => StepRecord | undefined) | undefined
	/** Concurrency-safe scope wrapper for running a seeder (used by createSeederInstance) */
	createSeederScope?:
		| ((options: { name: string; fresh: boolean; concurrent: boolean }) => SeederScopeHandle)
		| undefined
	/** Banner title (default: `'Seeders'`) */
	bannerName?: string | undefined
	/** Database URL the run writes to; non-local hosts are refused unless allowRemote */
	target?: (() => string | undefined) | undefined
	/** Called before the context is created */
	onBeforeAll?: (() => MaybePromise<void>) | undefined
	/** Called after all seeders complete, also when a seeder or the context factory throws */
	onAfterAll?: ((ctx: TContext | undefined) => MaybePromise<void>) | undefined
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
export function describeTarget(target: string): TargetDescription {
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
	if (hostParam) {
		try {
			hosts = decodeURIComponent(hostParam).split(',').filter(Boolean)
		} catch {
			return { label: 'a target with an invalid host parameter', local: false }
		}
	}

	const label = `${hosts.join(',') || 'local socket'}${path.startsWith('/') ? path : ''}`
	return { label, local: hosts.every(isLocalHost) }
}

/**
 * Core seeder runner - executes seeders in dependency order (sequentially or in parallel)
 *
 * @param seeders - Array of seeders to run
 * @param config - Instance configuration (context factory, lifecycle hooks)
 * @param options - Runner options (verbose output, concurrency, etc.)
 * @returns Object containing `success`, `results`, and `outputs`
 * @throws Dependency errors, `UnknownSeederError`, `SeedTargetError`, or `RangeError` (invalid concurrency), before any hook runs
 */
export async function runSeedersCore<
	TContext,
	const TSeeders extends readonly SeederAny[] = readonly SeederAny[],
	const TOptions extends RunSeedersOptions = RunSeedersOptions,
>(
	seeders: TSeeders,
	config: InternalSeederConfig<TContext>,
	options: TOptions = {} as TOptions,
): Promise<RunSeedersResult<TSeeders, TOptions>> {
	const {
		printResults = true,
		verbose = true,
		continueOnFailure = false,
		only,
		fresh = false,
		allowRemote = false,
		concurrency = 1,
	} = options

	if (
		Number.isNaN(concurrency) ||
		concurrency < 1 ||
		(Number.isFinite(concurrency) && !Number.isInteger(concurrency))
	) {
		throw new RangeError(
			`Invalid concurrency (${String(concurrency)}): expected a positive integer or Infinity`,
		)
	}

	// Validate everything before setting the seeding flag or touching the database
	const orderedNames = resolveDependencyOrder(seeders, only)

	const seederMap = new Map<string, SeederAny>()
	for (const seeder of seeders) {
		seederMap.set(seeder.name, seeder)
	}

	const freshSet = Array.isArray(fresh) ? new Set<string>(fresh) : undefined
	if (freshSet) {
		for (const name of freshSet) {
			if (!seederMap.has(name)) throw new UnknownSeederError(name, [...seederMap.keys()])
		}
	}

	const targetUrl = config.target?.()
	const target = targetUrl ? describeTarget(targetUrl) : undefined
	if (target && !target.local && !allowRemote) {
		throw new SeedTargetError(target.label)
	}

	const isFresh = (name: string): boolean => fresh === true || (freshSet?.has(name) ?? false)

	// Initialize results in deterministic topological order
	const results: SeederResult[] = orderedNames.map((name) => ({
		name,
		status: 'pending',
	}))
	const resultIndex = new Map<string, number>()
	for (let i = 0; i < orderedNames.length; i++) {
		resultIndex.set(orderedNames[i]!, i)
	}

	// Store outputs for dependency injection and return value
	const outputs: Record<string, unknown> = {}

	// Track failed (and skipped) seeders to skip their dependents
	const failedSeeders = new Set<string>()
	const concurrent = concurrency > 1

	enterSeeding()
	try {
		if (verbose) {
			printStartBanner({
				name: config.bannerName,
				count: orderedNames.length,
				target,
				concurrency,
			})
		}

		const runStartTime = performance.now()

		if (config.onBeforeAll) {
			await config.onBeforeAll()
		}

		let ctx: TContext | undefined
		try {
			if (config.preloadCache) {
				await config.preloadCache()
			}

			// Create context once for all seeders
			ctx = await config.context()
			const activeCtx = ctx

			const executeSeeder = async (name: string): Promise<boolean> => {
				const idx = resultIndex.get(name)
				const seeder = seederMap.get(name)
				if (idx === undefined || !seeder) return true

				const scopeHandle: SeederScopeHandle = config.createSeederScope
					? config.createSeederScope({ name, fresh: isFresh(name), concurrent })
					: {
							record: config.beforeSeeder?.(name, { fresh: isFresh(name) }),
							run: (fn) => fn(),
						}

				const deps: Record<string, unknown> = {}
				for (const depName of seeder.dependsOn) {
					deps[depName] = outputs[depName]
				}

				const startTime = performance.now()

				try {
					const output = await scopeHandle.run(async () => seeder.run(activeCtx, deps))
					const durationMs = Math.round(performance.now() - startTime)

					outputs[name] = output
					results[idx] = {
						name,
						status: 'completed',
						durationMs,
						output,
						cachedSteps: scopeHandle.record?.cachedSteps ?? [],
					}

					if (verbose) {
						if (concurrent) {
							printConcurrentComplete(name, durationMs, true)
						} else {
							printSeederComplete(durationMs, true)
						}
					}
					return true
				} catch (error) {
					const durationMs = Math.round(performance.now() - startTime)
					const err = error instanceof Error ? error : new Error(String(error))
					const failedStep =
						scopeHandle.record?.failed && scopeHandle.record.failed.error === error
							? scopeHandle.record.failed.step
							: undefined

					results[idx] = {
						name,
						status: 'failed',
						durationMs,
						error: err,
						...(failedStep !== undefined ? { failedStep } : {}),
						cachedSteps: scopeHandle.record?.cachedSteps ?? [],
					}
					failedSeeders.add(name)

					if (verbose) {
						if (concurrent) {
							printConcurrentComplete(name, durationMs, false)
						} else {
							printSeederComplete(durationMs, false)
						}
					}
					return false
				}
			}

			if (!concurrent) {
				// Sequential execution in topological order
				for (let i = 0; i < orderedNames.length; i++) {
					const name = orderedNames[i]
					if (!name) continue
					const seeder = seederMap.get(name)
					if (!seeder) continue

					if (continueOnFailure) {
						const failedDeps = seeder.dependsOn.filter((dep) => failedSeeders.has(dep))
						if (failedDeps.length > 0) {
							results[i] = { name, status: 'skipped', failedDeps }
							failedSeeders.add(name)
							if (verbose) {
								printSeederHeader(name, i, orderedNames.length, seeder.description)
								printSeederSkipped(failedDeps)
							}
							continue
						}
					}

					if (verbose) {
						printSeederHeader(name, i, orderedNames.length, seeder.description)
					}

					const ok = await executeSeeder(name)
					if (!ok && !continueOnFailure) {
						break
					}
				}
			} else if (orderedNames.length > 0) {
				// Parallel DAG worker pool with critical-path (longest-downstream-chain-first) scheduling
				const remainingDeps = new Map<string, number>()
				const dependents = new Map<string, string[]>()

				for (const name of orderedNames) {
					remainingDeps.set(name, 0)
					dependents.set(name, [])
				}

				for (const name of orderedNames) {
					const seeder = seederMap.get(name)
					if (!seeder) continue
					const uniqueDeps = new Set(seeder.dependsOn)
					remainingDeps.set(name, uniqueDeps.size)
					for (const dep of uniqueDeps) {
						dependents.get(dep)?.push(name)
					}
				}

				// Compute critical-path height (longest chain of downstream dependents) in reverse topo order
				const criticalHeight = new Map<string, number>()
				for (let i = orderedNames.length - 1; i >= 0; i--) {
					const name = orderedNames[i]!
					let maxHeight = 0
					for (const dependent of dependents.get(name) ?? []) {
						const h = (criticalHeight.get(dependent) ?? 0) + 1
						if (h > maxHeight) maxHeight = h
					}
					criticalHeight.set(name, maxHeight)
				}

				const ready: string[] = []
				for (const name of orderedNames) {
					if (remainingDeps.get(name) === 0) {
						ready.push(name)
					}
				}

				const popHighestPriority = (): string => {
					let bestIdx = 0
					let bestHeight = criticalHeight.get(ready[0]!) ?? 0
					let bestOrder = resultIndex.get(ready[0]!) ?? 0
					for (let i = 1; i < ready.length; i++) {
						const candidate = ready[i]!
						const h = criticalHeight.get(candidate) ?? 0
						const order = resultIndex.get(candidate) ?? 0
						if (h > bestHeight || (h === bestHeight && order < bestOrder)) {
							bestIdx = i
							bestHeight = h
							bestOrder = order
						}
					}
					return ready.splice(bestIdx, 1)[0]!
				}

				await new Promise<void>((resolve) => {
					let inFlight = 0
					let stopped = false

					const markSettled = (settledName: string) => {
						const deps = dependents.get(settledName)
						if (!deps) return
						for (const dependent of deps) {
							const next = (remainingDeps.get(dependent) ?? 1) - 1
							remainingDeps.set(dependent, next)
							if (next !== 0 || stopped) continue

							const seeder = seederMap.get(dependent)
							if (!seeder) continue

							const failedDeps = seeder.dependsOn.filter((d) => failedSeeders.has(d))
							if (failedDeps.length > 0) {
								const idx = resultIndex.get(dependent)
								if (idx !== undefined) {
									results[idx] = { name: dependent, status: 'skipped', failedDeps }
								}
								failedSeeders.add(dependent)
								if (verbose) {
									printConcurrentSkipped(dependent, failedDeps)
								}
								markSettled(dependent)
							} else {
								ready.push(dependent)
							}
						}
					}

					const schedule = () => {
						while (!stopped && inFlight < concurrency && ready.length > 0) {
							const name = popHighestPriority()
							inFlight++
							void executeSeeder(name).then((ok) => {
								inFlight--
								if (!ok && !continueOnFailure) {
									stopped = true
								} else {
									markSettled(name)
								}
								schedule()
							})
						}

						if (inFlight === 0 && (stopped || ready.length === 0)) {
							resolve()
						}
					}

					schedule()
				})
			}

			if (printResults) {
				printResultsTable(results)
				printErrors(results)
				printSummary(results, performance.now() - runStartTime, concurrency)
			}
		} finally {
			try {
				if (config.flushCache) {
					await config.flushCache()
				}
			} finally {
				if (config.onAfterAll) {
					await config.onAfterAll(ctx)
				}
			}
		}
	} finally {
		exitSeeding()
	}

	const hasFailure = results.some((r) => r.status === 'failed')
	if (hasFailure) {
		return {
			success: false,
			results: results as SeederResultFor<TSeeders>[],
			outputs: outputs as Partial<Record<string, unknown>>,
		} as RunSeedersResult<TSeeders, TOptions>
	}
	return {
		success: true,
		results: results as SeederResultFor<TSeeders>[],
		outputs,
	} as RunSeedersResult<TSeeders, TOptions>
}
