import type { MaybePromise } from './types.js'

/**
 * Run `fn` over `items` with at most `limit` calls in flight, and resolve to the results
 * in the order of `items`, whatever order the calls finish in.
 *
 * Fails fast: after the first call throws or rejects, no further item starts. It waits for
 * the calls already in flight to settle, so nothing still runs once it rejects (with the
 * first error; later errors are dropped).
 *
 * @param limit - A positive integer, or `Infinity` for no limit
 * @throws {RangeError} When `limit` is not a positive integer or `Infinity`
 *
 * @example
 * ```typescript
 * const products = await mapWithLimit(bodies, 8, (body) => api.post('/products', body))
 * ```
 */
export async function mapWithLimit<Item, Result>(
	items: Iterable<Item>,
	limit: number,
	fn: (item: Item, index: number) => MaybePromise<Result>,
): Promise<Result[]> {
	if (Number.isNaN(limit) || limit < 1 || (Number.isFinite(limit) && !Number.isInteger(limit))) {
		throw new RangeError(
			`Invalid limit (${String(limit)}): expected a positive integer or Infinity`,
		)
	}
	const list = Array.from(items)
	const results = new Array<Result>(list.length)
	let next = 0
	let failure: { error: unknown } | undefined

	const worker = async () => {
		while (!failure && next < list.length) {
			const index = next++
			try {
				results[index] = await fn(list[index] as Item, index)
			} catch (error) {
				failure ??= { error }
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))

	if (failure) throw failure.error
	return results
}
