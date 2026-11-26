import { describe, expect, it } from 'bun:test'
import { mapWithLimit } from './map-with-limit.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('mapWithLimit', () => {
	it('keeps the order of items whatever order the calls finish in, and passes the index', async () => {
		const results = await mapWithLimit([30, 0, 15, 5], 2, async (delay, index) => {
			await sleep(delay)
			return `${index}:${delay}`
		})
		expect(results).toEqual(['0:30', '1:0', '2:15', '3:5'])
	})

	it('never has more than limit calls in flight', async () => {
		let inFlight = 0
		let peak = 0
		await mapWithLimit(
			Array.from({ length: 20 }, (_, i) => i),
			3,
			async (i) => {
				inFlight++
				peak = Math.max(peak, inFlight)
				await sleep(i % 4)
				inFlight--
			},
		)
		expect(peak).toBe(3)
	})

	it('runs every item at once with Infinity, and handles an empty list and sync functions', async () => {
		let inFlight = 0
		let peak = 0
		await mapWithLimit([1, 2, 3, 4], Number.POSITIVE_INFINITY, async () => {
			inFlight++
			peak = Math.max(peak, inFlight)
			await sleep(1)
			inFlight--
		})
		expect(peak).toBe(4)
		expect(await mapWithLimit([], 4, () => 1)).toEqual([])
		expect(await mapWithLimit(new Set(['a', 'b']), 1, (item) => item.toUpperCase())).toEqual([
			'A',
			'B',
		])
	})

	it('fails fast: starts nothing after the first error, waits for calls in flight, and rejects with the first error', async () => {
		const started: number[] = []
		const settled: number[] = []
		const run = mapWithLimit([0, 1, 2, 3, 4, 5], 3, async (i) => {
			started.push(i)
			if (i === 1) {
				await sleep(5)
				throw new Error('item 1 failed')
			}
			await sleep(i === 2 ? 10 : 20)
			settled.push(i)
			if (i === 2) throw new Error('item 2 failed later')
			return i
		})

		await expect(run).rejects.toThrow('item 1 failed')
		// 0 and 2 were in flight when item 1 failed: they settled before the rejection, and 3 to 5 never started
		expect(started).toEqual([0, 1, 2])
		expect(settled.sort()).toEqual([0, 2])
	})

	it('treats a synchronous throw like a rejection', async () => {
		await expect(
			mapWithLimit([1, 2], 1, () => {
				throw new Error('sync')
			}),
		).rejects.toThrow('sync')
	})

	it('throws RangeError for a limit that is not a positive integer or Infinity', async () => {
		for (const limit of [0, -1, 1.5, Number.NaN]) {
			await expect(mapWithLimit([1], limit, () => 1)).rejects.toThrow(RangeError)
		}
	})
})
