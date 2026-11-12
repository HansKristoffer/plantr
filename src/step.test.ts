import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createStepRunner, type SeederCache } from './step'

describe('createStepRunner', () => {
	beforeEach(() => {
		// Silence console output during tests
		spyOn(console, 'log').mockImplementation(() => {})
	})

	describe('basic step execution', () => {
		it('should execute step and return result', async () => {
			const { step } = createStepRunner()
			const result = await step('Test step', () => 42)
			expect(result).toBe(42)
		})

		it('should execute async step and return result', async () => {
			const { step } = createStepRunner()
			const result = await step('Async step', async () => {
				await new Promise((r) => setTimeout(r, 10))
				return 'async result'
			})
			expect(result).toBe('async result')
		})

		it('should propagate errors from step', async () => {
			const { step } = createStepRunner()
			await expect(
				step('Failing step', () => {
					throw new Error('Step failed')
				}),
			).rejects.toThrow('Step failed')
		})

		it('should propagate async errors from step', async () => {
			const { step } = createStepRunner()
			await expect(
				step('Async failing step', async () => {
					throw new Error('Async step failed')
				}),
			).rejects.toThrow('Async step failed')
		})
	})

	describe('setSeederName', () => {
		it('should set seeder name for cache key scoping', async () => {
			const cache: SeederCache = {
				get: mock(async () => undefined),
				set: mock(async () => {}),
			}

			const { step, setSeederName } = createStepRunner({ cache })
			setSeederName('mySeeder')

			await step('Create item', () => 'result', { useCache: true })

			expect(cache.set).toHaveBeenCalledWith('mySeeder:create-item', {
				__plantr: 1,
				value: 'result',
			})
		})
	})

	describe('caching', () => {
		const jsonStore = () => {
			const store = new Map<string, string>()
			const cache: SeederCache = {
				get: async <T>(key: string) => {
					const raw = store.get(key)
					return raw === undefined ? undefined : (JSON.parse(raw) as T)
				},
				set: async <T>(key: string, value: T) => {
					store.set(key, JSON.stringify(value))
				},
			}
			return { store, cache }
		}

		/** One run of one cached step on a fresh runner, as runSeeders does */
		const runOnce = async <T>(
			cache: SeederCache,
			fn: () => T,
			options: { version?: unknown; fresh?: boolean } = {},
		) => {
			const { step, setSeederName } = createStepRunner({ cache })
			const record = setSeederName('testSeeder', { fresh: options.fresh })
			const value = await step('Cached step', fn, { useCache: true, version: options.version })
			return { value, record }
		}

		it('should return the cached value on the next run', async () => {
			const { cache } = jsonStore()
			const fn = mock(() => 'computed value')

			expect((await runOnce(cache, fn)).value).toBe('computed value')
			const second = await runOnce(cache, fn)

			expect(second.value).toBe('computed value')
			expect(second.record.cachedSteps).toEqual(['Cached step'])
			expect(fn).toHaveBeenCalledTimes(1)
		})

		it('should cache a step that returns undefined', async () => {
			const { cache } = jsonStore()
			const fn = mock(() => undefined)

			await runOnce(cache, fn)
			const second = await runOnce(cache, fn)

			expect(second.value).toBeUndefined()
			expect(fn).toHaveBeenCalledTimes(1)
		})

		it('should rerun and overwrite when the version changes', async () => {
			const { cache } = jsonStore()

			await runOnce(cache, () => 'v1', { version: 1 })
			expect((await runOnce(cache, () => 'v2', { version: 2 })).value).toBe('v2')
			expect((await runOnce(cache, () => 'v3', { version: 2 })).value).toBe('v2')
		})

		it('should rerun and overwrite when the seeder runs fresh', async () => {
			const { cache } = jsonStore()

			await runOnce(cache, () => 'old')
			expect((await runOnce(cache, () => 'new', { fresh: true })).value).toBe('new')
			expect((await runOnce(cache, () => 'unused')).value).toBe('new')
		})

		it('should read a bare value written by plantr 1.x', async () => {
			const { store, cache } = jsonStore()
			store.set('testSeeder:cached-step', JSON.stringify({ userId: 'u1' }))
			const fn = mock(() => ({ userId: 'u2' }))

			expect((await runOnce(cache, fn)).value).toEqual({ userId: 'u1' })
			expect(fn).not.toHaveBeenCalled()
			// A version was never stored by 1.x, so asking for one is a miss
			expect((await runOnce(cache, fn, { version: 1 })).value).toEqual({ userId: 'u2' })
		})

		it('should throw when two cached steps in one run share a key', async () => {
			const { cache } = jsonStore()
			const { step, setSeederName } = createStepRunner({ cache })
			const record = setSeederName('userSeeder')

			await step('Create user', () => 'Alice', { useCache: true })
			await expect(step('create user!', () => 'Bob', { useCache: true })).rejects.toThrow(
				'userSeeder:create-user',
			)
			expect(record.failed?.step).toBe('create user!')
		})

		it('should not cache when useCache is false (default)', async () => {
			const cache: SeederCache = {
				get: mock(async () => undefined),
				set: mock(async () => {}),
			}

			const { step } = createStepRunner({ cache })
			await step('Non-cached step', () => 'result')

			expect(cache.get).not.toHaveBeenCalled()
			expect(cache.set).not.toHaveBeenCalled()
		})

		it('should warn when useCache is true but no cache configured', async () => {
			const consoleSpy = spyOn(console, 'log')
			const { step } = createStepRunner() // No cache

			await step('Step without cache', () => 'result', { useCache: true })

			const calls = consoleSpy.mock.calls.flat()
			expect(calls.some((c) => String(c).includes('Cache not configured'))).toBe(true)
		})

		it('should print nothing when log is false', async () => {
			const consoleSpy = spyOn(console, 'log')
			consoleSpy.mockClear()
			const { step } = createStepRunner({ log: false })

			await step('Quiet step', () => 'result', { useCache: true })
			await expect(
				step('Quiet failure', () => {
					throw new Error('no')
				}),
			).rejects.toThrow('no')

			expect(consoleSpy).not.toHaveBeenCalled()
		})

		it('should scope cache keys by seeder name', async () => {
			const { store, cache } = jsonStore()
			const { step, setSeederName } = createStepRunner({ cache })

			setSeederName('seederA')
			await step('Create user', () => 'user-a', { useCache: true })
			setSeederName('seederB')
			await step('Create user', () => 'user-b', { useCache: true })

			expect([...store.keys()]).toEqual(['seederA:create-user', 'seederB:create-user'])
		})
	})
})
