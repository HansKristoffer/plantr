/**
 * Marks an error as a usage or configuration problem. Set it to `true` on any error (or
 * throw `SeedUsageError`) and `runSeedersCli` prints only the message and exits 1, and a
 * seeder failing with it is reported without a stack trace. A registered symbol, so it also
 * works across copies of plantr and on errors from your own classes.
 */
export const usageErrorSymbol: unique symbol = Symbol.for('plantr.usageError')

/**
 * A usage or configuration error: a refused target, a missing environment variable, a bad
 * argument. The message should say what to do; the CLI prints only it, without a stack trace.
 */
export class SeedUsageError extends Error {
	readonly [usageErrorSymbol] = true

	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'SeedUsageError'
	}
}

/** Whether `error` is marked as a usage error (`SeedUsageError`, or `usageErrorSymbol` set to true) */
export function isSeedUsageError(error: unknown): error is Error {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { [usageErrorSymbol]?: unknown })[usageErrorSymbol] === true
	)
}
