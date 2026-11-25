import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createStepRunner, type SeederCache } from './step.js'
import type { JsonValue } from './types.js'

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

		it('should preserve the innermost failing step name when steps are nested', async () => {
			const { step, setSeederName } = createStepRunner()
			const record = setSeederName('nestedSeeder')

			await expect(
				step('Outer step', async () => {
					await step('Inner step', () => {
						throw new Error('boom')
					})
				}),
			).rejects.toThrow('boom')

			expect(record.failed?.step).toBe('Inner step')
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
				get: (key) => {
					const raw = store.get(key)
					return raw === undefined ? undefined : JSON.parse(raw)
				},
				set: (key, value) => {
					store.set(key, JSON.stringify(value))
				},
			}
			return { store, cache }
		}

		/** One run of one cached step on a fresh runner, as runSeeders does */
		const runOnce = async <T>(
			cache: SeederCache,
			fn: () => T,
			options: { version?: JsonValue; fresh?: boolean; key?: string } = {},
		) => {
			const { step, setSeederName } = createStepRunner({ cache })
			const record = setSeederName('testSeeder', { fresh: options.fresh })
			const value = await step('Cached step', fn, {
				useCache: true,
				version: options.version,
				key: options.key,
			})
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

		it('should cache a step that returns undefined or null', async () => {
			const { cache } = jsonStore()
			const fnUndef = mock(() => undefined)
			await runOnce(cache, fnUndef, { key: 'undef' })
			expect((await runOnce(cache, fnUndef, { key: 'undef' })).value).toBeUndefined()
			expect(fnUndef).toHaveBeenCalledTimes(1)

			const fnNull = mock(() => null)
			await runOnce(cache, fnNull, { key: 'null-val' })
			expect((await runOnce(cache, fnNull, { key: 'null-val' })).value).toBeNull()
			expect(fnNull).toHaveBeenCalledTimes(1)
		})

		it('should treat null returned by cache.get as a cache miss', async () => {
			const cache: SeederCache = {
				get: () => null,
				set: mock(() => {}),
			}
			const fn = mock(() => 'fresh-value')

			const result = await runOnce(cache, fn)
			expect(result.value).toBe('fresh-value')
			expect(result.record.cachedSteps).toEqual([])
			expect(fn).toHaveBeenCalledTimes(1)
		})

		it('should rerun and overwrite when the version changes', async () => {
			const { cache } = jsonStore()

			await runOnce(cache, () => 'v1', { version: 1 })
			expect((await runOnce(cache, () => 'v2', { version: 2 })).value).toBe('v2')
			expect((await runOnce(cache, () => 'v3', { version: 2 })).value).toBe('v2')
		})

		it('should compare object versions deterministically regardless of key order', async () => {
			const { cache } = jsonStore()
			const fn = mock(() => 'computed')

			await runOnce(cache, fn, { version: { b: 2, a: 1, nested: { y: true, x: false } } })
			const second = await runOnce(cache, fn, {
				version: { a: 1, nested: { x: false, y: true }, b: 2 },
			})

			expect(second.value).toBe('computed')
			expect(second.record.cachedSteps).toEqual(['Cached step'])
			expect(fn).toHaveBeenCalledTimes(1)
		})

		it('should support explicit step cache keys independent of description', async () => {
			const { store, cache } = jsonStore()
			const fn = mock(() => 'u1')

			const r1 = createStepRunner({ cache })
			r1.setSeederName('users')
			await r1.step('Create admin user', fn, { useCache: true, key: 'admin-user' })

			const r2 = createStepRunner({ cache })
			r2.setSeederName('users')
			const val = await r2.step('Create default admin user (reworded)', fn, {
				useCache: true,
				key: 'admin-user',
			})

			expect(val).toBe('u1')
			expect(fn).toHaveBeenCalledTimes(1)
			expect([...store.keys()]).toEqual(['users:admin-user'])
		})

		it('should preload entries once via cache.getAll and avoid per-step cache.get calls', async () => {
			const get = mock(() => undefined)
			const store = new Map<string, unknown>([
				['users:step-a', { __plantr: 1, value: 'a-cached' }],
				['users:step-b', { __plantr: 1, value: 'b-cached' }],
			])
			const getAll = mock(() => store)
			const set = mock((k: string, v: unknown) => {
				store.set(k, v)
			})
			const cache: SeederCache = { get, set, getAll }

			const runner = createStepRunner({ cache })
			await runner.preload()
			const record = runner.setSeederName('users')

			const a = await runner.step('Step A', () => 'a-new', { useCache: true })
			const b = await runner.step('Step B', () => 'b-new', { useCache: true })
			const c = await runner.step('Step C', () => 'c-new', { useCache: true })

			expect([a, b, c]).toEqual(['a-cached', 'b-cached', 'c-new'])
			expect(record.cachedSteps).toEqual(['Step A', 'Step B'])
			expect(getAll).toHaveBeenCalledTimes(1)
			expect(get).not.toHaveBeenCalled()
			expect(set).toHaveBeenCalledTimes(1)
		})

		it('should buffer writes and flush in a single batch when cache.setMany is provided', async () => {
			const set = mock(() => {})
			const flushed: { key: string; value: unknown }[][] = []
			const setMany = mock((entries: readonly { key: string; value: unknown }[]) => {
				flushed.push([...entries])
			})
			const cache: SeederCache = {
				get: () => undefined,
				set,
				setMany,
			}

			const runner = createStepRunner({ cache })
			runner.setSeederName('users')

			await runner.step('Step 1', () => 'one', { useCache: true })
			await runner.step('Step 2', () => 'two', { useCache: true })

			expect(set).not.toHaveBeenCalled()
			expect(setMany).not.toHaveBeenCalled()

			await runner.flush()

			expect(setMany).toHaveBeenCalledTimes(1)
			expect(flushed[0]).toEqual([
				{ key: 'users:step-1', value: { __plantr: 1, value: 'one' } },
				{ key: 'users:step-2', value: { __plantr: 1, value: 'two' } },
			])
		})

		it('should isolate concurrent step scopes via runWithScope', async () => {
			const { store, cache } = jsonStore()
			const runner = createStepRunner({ cache })

			const scopeA = runner.createScope({ seederName: 'seederA', prefix: 'seederA' })
			const scopeB = runner.createScope({ seederName: 'seederB', prefix: 'seederB' })

			await Promise.all([
				runner.runWithScope(scopeA, async () => {
					await runner.step(
						'Create item',
						async () => {
							await Bun.sleep(10)
							return 'from-a'
						},
						{ useCache: true },
					)
				}),
				runner.runWithScope(scopeB, async () => {
					await runner.step(
						'Create item',
						async () => {
							await Bun.sleep(2)
							return 'from-b'
						},
						{ useCache: true },
					)
				}),
			])

			expect([...store.keys()].sort()).toEqual(['seederA:create-item', 'seederB:create-item'])
			expect(JSON.parse(store.get('seederA:create-item')!).value).toBe('from-a')
			expect(JSON.parse(store.get('seederB:create-item')!).value).toBe('from-b')
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

		it('should warn once per run when useCache is true but no cache configured', async () => {
			const consoleSpy = spyOn(console, 'log')
			consoleSpy.mockClear()
			const { step } = createStepRunner() // No cache

			await step('Step without cache 1', () => 'result1', { useCache: true })
			await step('Step without cache 2', () => 'result2', { useCache: true })

			const warnings = consoleSpy.mock.calls
				.flat()
				.filter((c) => String(c).includes('Cache not configured'))
			expect(warnings).toHaveLength(1)
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
