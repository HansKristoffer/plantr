import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { faker as fakerDE } from '@faker-js/faker/locale/de'
import { runCli } from './cli.js'
import { createSeederInstance } from './create-seeder-instance.js'
import { MissingDependencyError, UnknownSeederError } from './dependency-resolver.js'
import { colorize } from './formatting.js'
import { describeTarget, SeedTargetError } from './run-seeders.js'
import { isSeedingActive, setSeedingActive } from './seeding-state.js'
import type { SeederCache } from './step.js'
import type { BaseSeederContext, Seeder } from './types.js'

describe('integration', () => {
	beforeEach(() => {
		// Reset seeding state and silence console
		setSeedingActive(false)
		spyOn(console, 'log').mockImplementation(() => {})
		spyOn(console, 'error').mockImplementation(() => {})
	})

	describe('createSeederInstance', () => {
		it('should create a seeder instance with zero config', async () => {
			const { defineSeeder, runSeeders, runSeedersCli, isSeedingActive } = createSeederInstance()

			expect(typeof defineSeeder).toBe('function')
			expect(typeof runSeeders).toBe('function')
			expect(typeof runSeedersCli).toBe('function')
			expect(typeof isSeedingActive).toBe('function')

			const seeder = defineSeeder({
				name: 'syncSeeder',
				run: ({ faker }) => ({ name: faker.person.fullName() }),
			})

			const run = await runSeeders([seeder], { printResults: false, verbose: false })
			expect(run.success).toBe(true)
			if (run.success) {
				expect(typeof run.outputs.syncSeeder.name).toBe('string')
			}
		})

		it('should run a simple seeder and return typed outputs', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: (base) => base,
			})

			const seeder = defineSeeder({
				name: 'simpleSeeder',
				run: async () => ({ value: 42 }),
			})

			const run = await runSeeders([seeder], {
				printResults: false,
				verbose: false,
			})

			expect(run.success).toBe(true)
			expect(run.results).toHaveLength(1)
			expect(run.results[0]?.status).toBe('completed')
			if (run.results[0]?.status === 'completed') {
				expect(run.results[0].output).toEqual({ value: 42 })
			}
			if (run.success) {
				expect(run.outputs.simpleSeeder).toEqual({ value: 42 })
			}
		})

		it('should provide faker, step, and expect in context', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance()

			let contextReceived: BaseSeederContext | null = null

			const seeder = defineSeeder({
				name: 'contextSeeder',
				run: async (ctx) => {
					contextReceived = ctx
					return {}
				},
			})

			await runSeeders([seeder], { printResults: false, verbose: false })

			expect(contextReceived).not.toBeNull()
			expect(typeof contextReceived!.faker).toBe('object')
			expect(typeof contextReceived!.step).toBe('function')
			expect(typeof contextReceived!.expect).toBe('function')
		})

		it('should auto-merge custom context without requiring ...base or explicit generics', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: () => ({
					customHelper: () => 'custom value',
				}),
			})

			let result = ''
			let hasFaker = false

			const seeder = defineSeeder({
				name: 'customContextSeeder',
				run: ({ customHelper, faker }) => {
					result = customHelper()
					hasFaker = typeof faker.person.fullName === 'function'
					return { result }
				},
			})

			const run = await runSeeders([seeder], { printResults: false, verbose: false })

			expect(result).toBe('custom value')
			expect(hasFaker).toBe(true)
			expect(run.success).toBe(true)
			if (run.success) {
				expect(run.outputs.customContextSeeder.result).toBe('custom value')
			}
		})

		it('should still support explicit <CustomContext> generic and spreading ...base', async () => {
			type CustomContext = BaseSeederContext & { customHelper: () => string }

			const { defineSeeder, runSeeders } = createSeederInstance<CustomContext>({
				context: (base) => ({
					...base,
					customHelper: () => 'legacy value',
				}),
			})

			let result = ''
			const seeder = defineSeeder({
				name: 'legacySeeder',
				run: async (ctx) => {
					result = ctx.customHelper()
					return {}
				},
			})

			await runSeeders([seeder], { printResults: false, verbose: false })
			expect(result).toBe('legacy value')
		})

		it('should support a custom faker locale instance', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				faker: fakerDE,
				fakerSeed: 7,
			})

			const seeder = defineSeeder({
				name: 'deSeeder',
				run: ({ faker }) => ({
					name: faker.person.fullName(),
					city: faker.location.city(),
				}),
			})

			const run1 = await runSeeders([seeder], { printResults: false, verbose: false })
			const run2 = await runSeeders([seeder], { printResults: false, verbose: false })

			expect(run1.success).toBe(true)
			expect(run2.success).toBe(true)
			if (run1.success && run2.success) {
				expect(run1.outputs.deSeeder).toEqual(run2.outputs.deSeeder)
			}
		})

		it('should pass dependencies between seeders', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance()

			const seederA = defineSeeder({
				name: 'seederA',
				run: async () => ({ userId: 'user-123' }),
			})

			const seederB = defineSeeder({
				name: 'seederB',
				dependsOn: [seederA],
				run: async (_ctx, deps) => {
					return { postAuthor: deps.seederA.userId }
				},
			})

			const run = await runSeeders([seederB, seederA], {
				printResults: false,
				verbose: false,
			})

			expect(run.success).toBe(true)
			expect(run.results).toHaveLength(2)
			if (run.success) {
				expect(run.outputs.seederB).toEqual({ postAuthor: 'user-123' })
			}
		})

		it('should set seeding state during execution and reference-count overlapping runs', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance()

			const statesDuringRun: boolean[] = []

			const fast = defineSeeder({
				name: 'fast',
				run: async () => {
					statesDuringRun.push(isSeedingActive())
					await Bun.sleep(5)
					return 'fast'
				},
			})

			const slow = defineSeeder({
				name: 'slow',
				run: async () => {
					await Bun.sleep(20)
					statesDuringRun.push(isSeedingActive())
					return 'slow'
				},
			})

			expect(isSeedingActive()).toBe(false)
			await Promise.all([
				runSeeders([fast], { printResults: false, verbose: false }),
				runSeeders([slow], { printResults: false, verbose: false }),
			])
			expect(isSeedingActive()).toBe(false)
			expect(statesDuringRun).toEqual([true, true])
		})

		it('should call onBeforeAll and pass created context to onAfterAll', async () => {
			const beforeAll = mock(async () => {})
			let receivedClient: string | undefined

			const { defineSeeder, runSeeders } = createSeederInstance({
				context: () => ({ client: 'db-conn' }),
				onBeforeAll: beforeAll,
				onAfterAll: (ctx) => {
					receivedClient = ctx?.client
				},
			})

			const seeder = defineSeeder({
				name: 'hookSeeder',
				run: async () => ({}),
			})

			await runSeeders([seeder], { printResults: false, verbose: false })

			expect(beforeAll).toHaveBeenCalledTimes(1)
			expect(receivedClient).toBe('db-conn')
		})

		it('should pass undefined to onAfterAll when context factory throws', async () => {
			const afterAll = mock((_ctx: unknown) => {})
			const { defineSeeder, runSeeders } = createSeederInstance({
				context: () => {
					throw new Error('context boom')
				},
				onAfterAll: afterAll,
			})
			const seeder = defineSeeder({ name: 'a', run: () => ({}) })

			await expect(runSeeders([seeder], { verbose: false })).rejects.toThrow('context boom')
			expect(afterAll).toHaveBeenCalledWith(undefined)
			expect(isSeedingActive()).toBe(false)
		})

		it('should handle seeder failure', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance()

			const seeder = defineSeeder({
				name: 'failingSeeder',
				run: async () => {
					throw new Error('Seeder failed!')
				},
			})

			const { results, success } = await runSeeders([seeder], {
				printResults: false,
				verbose: false,
			})

			expect(success).toBe(false)
			expect(results).toHaveLength(1)
			expect(results[0]?.status).toBe('failed')
			if (results[0]?.status === 'failed') {
				expect(results[0].error.message).toBe('Seeder failed!')
			}
		})

		it('should stop on failure by default', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance()

			const seederA = defineSeeder({
				name: 'seederA',
				run: async () => {
					throw new Error('Failed!')
				},
			})

			const seederB = defineSeeder({
				name: 'seederB',
				run: async () => ({ ran: true }),
			})

			const { results, success } = await runSeeders([seederA, seederB], {
				printResults: false,
				verbose: false,
			})

			expect(success).toBe(false)
			expect(results[0]?.status).toBe('failed')
			expect(results[1]?.status).toBe('pending') // Never ran
		})

		it('should continue on failure when continueOnFailure is true', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance()

			const seederA = defineSeeder({
				name: 'seederA',
				run: async () => {
					throw new Error('Failed!')
				},
			})

			const seederB = defineSeeder({
				name: 'seederB',
				run: async () => ({ ran: true }),
			})

			const { results, success } = await runSeeders([seederA, seederB], {
				printResults: false,
				verbose: false,
				continueOnFailure: true,
			})

			expect(success).toBe(false)
			expect(results[0]?.status).toBe('failed')
			expect(results[1]?.status).toBe('completed') // Ran despite seederA failing
		})

		it('should skip dependents of failed seeders when continueOnFailure is true', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance()

			const seederA = defineSeeder({
				name: 'seederA',
				run: async () => {
					throw new Error('Failed!')
				},
			})

			const seederB = defineSeeder({
				name: 'seederB',
				dependsOn: [seederA],
				run: async () => ({ ran: true }),
			})

			const seederC = defineSeeder({
				name: 'seederC',
				run: async () => ({ ran: true }),
			})

			const { results, success } = await runSeeders([seederA, seederB, seederC], {
				printResults: false,
				verbose: false,
				continueOnFailure: true,
			})

			expect(success).toBe(false)
			expect(results.find((r) => r.name === 'seederA')?.status).toBe('failed')
			const skipped = results.find((r) => r.name === 'seederB')
			expect(skipped?.status).toBe('skipped')
			if (skipped?.status === 'skipped') {
				expect(skipped.failedDeps).toEqual(['seederA'])
			}
			expect(results.find((r) => r.name === 'seederC')?.status).toBe('completed')
		})
	})

	describe('parallel execution (concurrency)', () => {
		it('should execute independent DAG branches concurrently and wait for dependencies', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance()
			let active = 0
			let maxActive = 0

			const track = async <T>(ms: number, value: T): Promise<T> => {
				active++
				maxActive = Math.max(maxActive, active)
				await Bun.sleep(ms)
				active--
				return value
			}

			const root = defineSeeder({
				name: 'root',
				run: () => track(5, { rootId: 'r1' }),
			})
			const branchA = defineSeeder({
				name: 'branchA',
				dependsOn: [root],
				run: (_ctx, deps) => track(25, `${deps.root.rootId}-a`),
			})
			const branchB = defineSeeder({
				name: 'branchB',
				dependsOn: [root],
				run: (_ctx, deps) => track(25, `${deps.root.rootId}-b`),
			})
			const join = defineSeeder({
				name: 'join',
				dependsOn: [branchA, branchB],
				run: (_ctx, deps) => `${deps.branchA}+${deps.branchB}`,
			})

			const run = await runSeeders([join, branchB, branchA, root], {
				concurrency: 4,
				verbose: false,
				printResults: false,
			})

			expect(run.success).toBe(true)
			expect(maxActive).toBe(2) // branchA and branchB overlapped
			if (run.success) {
				expect(run.outputs.join).toBe('r1-a+r1-b')
			}
			// Results remain in deterministic topological order
			expect(run.results.map((r) => r.name)[0]).toBe('root')
			expect(run.results.map((r) => r.name)[3]).toBe('join')
		})

		it('should isolate faker and step scopes across concurrent seeders (including helpers closing over base)', async () => {
			const store = new Map<string, unknown>()
			const cache: SeederCache = {
				get: (key) => store.get(key),
				set: (key, value) => {
					store.set(key, value)
				},
			}

			const makeInstance = () =>
				createSeederInstance({
					cache,
					fakerSeed: 42,
					context: (base) => ({
						generatePair: async (delayMs: number) => {
							const first = await base.step(
								'First name',
								async () => {
									await Bun.sleep(delayMs)
									return base.faker.person.fullName()
								},
								{ useCache: true },
							)
							const second = base.faker.internet.email()
							return { first, second }
						},
					}),
				})

			const runOnce = async (concurrency: number) => {
				store.clear()
				const { defineSeeder, runSeeders } = makeInstance()
				const alpha = defineSeeder({
					name: 'alpha',
					run: ({ generatePair }) => generatePair(15),
				})
				const beta = defineSeeder({
					name: 'beta',
					run: ({ generatePair }) => generatePair(5),
				})
				const res = await runSeeders([alpha, beta], {
					concurrency,
					verbose: false,
					printResults: false,
				})
				expect(res.success).toBe(true)
				return res.success ? res.outputs : null
			}

			const seq = await runOnce(1)
			const par = await runOnce(2)

			expect(par).toEqual(seq)
			expect([...store.keys()].sort()).toEqual(['alpha:first-name', 'beta:first-name'])
		})

		it('should skip transitive dependents when continueOnFailure is true in concurrent mode', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance()

			const a = defineSeeder({
				name: 'a',
				run: async () => {
					await Bun.sleep(5)
					throw new Error('a broke')
				},
			})
			const b = defineSeeder({
				name: 'b',
				dependsOn: [a],
				run: () => 'b',
			})
			const c = defineSeeder({
				name: 'c',
				dependsOn: [b],
				run: () => 'c',
			})
			const independent = defineSeeder({
				name: 'independent',
				run: async () => {
					await Bun.sleep(15)
					return 'ok'
				},
			})

			const run = await runSeeders([a, b, c, independent], {
				concurrency: 4,
				continueOnFailure: true,
				verbose: false,
				printResults: false,
			})

			expect(run.success).toBe(false)
			expect(run.results.find((r) => r.name === 'a')?.status).toBe('failed')
			const bRes = run.results.find((r) => r.name === 'b')
			const cRes = run.results.find((r) => r.name === 'c')
			expect(bRes?.status).toBe('skipped')
			expect(cRes?.status).toBe('skipped')
			if (bRes?.status === 'skipped') expect(bRes.failedDeps).toEqual(['a'])
			if (cRes?.status === 'skipped') expect(cRes.failedDeps).toEqual(['b'])
			expect(run.results.find((r) => r.name === 'independent')?.status).toBe('completed')
		})

		it('should wait for in-flight seeders before onAfterAll and leave unstarted seeders pending on failure', async () => {
			const events: string[] = []
			const { defineSeeder, runSeeders } = createSeederInstance({
				onAfterAll: () => {
					events.push('afterAll')
				},
			})

			const fastFail = defineSeeder({
				name: 'fastFail',
				run: async () => {
					await Bun.sleep(5)
					events.push('fastFail')
					throw new Error('boom')
				},
			})
			const slowOk = defineSeeder({
				name: 'slowOk',
				run: async () => {
					await Bun.sleep(25)
					events.push('slowOk')
					return 'done'
				},
			})
			const queued = defineSeeder({
				name: 'queued',
				run: () => {
					events.push('queued')
					return 'should-not-run'
				},
			})

			const run = await runSeeders([fastFail, slowOk, queued], {
				concurrency: 2,
				continueOnFailure: false,
				verbose: false,
				printResults: false,
			})

			expect(run.success).toBe(false)
			expect(events).toEqual(['fastFail', 'slowOk', 'afterAll'])
			expect(run.results.find((r) => r.name === 'queued')?.status).toBe('pending')
		})

		it('should throw RangeError on invalid concurrency before any hook runs', async () => {
			const beforeAll = mock(() => {})
			const { defineSeeder, runSeeders } = createSeederInstance({ onBeforeAll: beforeAll })
			const s = defineSeeder({ name: 'a', run: () => 1 })

			await expect(runSeeders([s], { concurrency: 0 })).rejects.toThrow(RangeError)
			await expect(runSeeders([s], { concurrency: -2 })).rejects.toThrow(RangeError)
			await expect(runSeeders([s], { concurrency: 1.5 })).rejects.toThrow(RangeError)
			await expect(runSeeders([s], { concurrency: Number.NaN })).rejects.toThrow(RangeError)
			expect(beforeAll).not.toHaveBeenCalled()
		})

		it('should honor instance-level default concurrency and allow per-run overrides', async () => {
			let active = 0
			let maxActive = 0
			const { defineSeeder, runSeeders } = createSeederInstance({ concurrency: 3 })

			const make = (name: string) =>
				defineSeeder({
					name,
					run: async () => {
						active++
						maxActive = Math.max(maxActive, active)
						await Bun.sleep(15)
						active--
						return name
					},
				})

			const seeders = [make('a'), make('b'), make('c')] as const
			await runSeeders(seeders, { verbose: false, printResults: false })
			expect(maxActive).toBe(3)

			// Per-run override back to sequential
			maxActive = 0
			await runSeeders(seeders, { concurrency: 1, verbose: false, printResults: false })
			expect(maxActive).toBe(1)
		})

		it('should prioritize critical-path chains before independent leaf seeders', async () => {
			const started: string[] = []
			const { defineSeeder, runSeeders } = createSeederInstance({ concurrency: 2 })

			const leaf1 = defineSeeder({
				name: 'leaf1',
				run: async () => {
					started.push('leaf1')
					await Bun.sleep(20)
				},
			})
			const leaf2 = defineSeeder({
				name: 'leaf2',
				run: async () => {
					started.push('leaf2')
					await Bun.sleep(20)
				},
			})
			const chainRoot = defineSeeder({
				name: 'chainRoot',
				run: async () => {
					started.push('chainRoot')
					await Bun.sleep(5)
				},
			})
			const chainMid = defineSeeder({
				name: 'chainMid',
				dependsOn: [chainRoot],
				run: async () => {
					started.push('chainMid')
					await Bun.sleep(5)
				},
			})
			const chainEnd = defineSeeder({
				name: 'chainEnd',
				dependsOn: [chainMid],
				run: async () => {
					started.push('chainEnd')
				},
			})

			// Even though leaves are registered first, chainRoot (height 2) launches immediately
			await runSeeders([leaf1, leaf2, chainRoot, chainMid, chainEnd], {
				verbose: false,
				printResults: false,
			})
			expect(started[0]).toBe('chainRoot')
		})

		it('should support parallel steps via Promise.all inside a single seeder and flush setMany before onAfterAll', async () => {
			const events: string[] = []
			const written: string[] = []
			const { defineSeeder, runSeeders } = createSeederInstance({
				cache: {
					get: () => undefined,
					set: () => {
						throw new Error('set should not be called when setMany is provided')
					},
					setMany: (entries) => {
						events.push('flushCache')
						for (const e of entries) written.push(e.key)
					},
				},
				onAfterAll: () => {
					events.push('onAfterAll')
				},
			})

			const first = defineSeeder({
				name: 'first',
				run: async ({ step }) => {
					const [a, b] = await Promise.all([
						step(
							'Step A',
							async () => {
								await Bun.sleep(10)
								return 'a'
							},
							{ useCache: true },
						),
						step(
							'Step B',
							async () => {
								await Bun.sleep(5)
								return 'b'
							},
							{ useCache: true },
						),
					])
					return { a, b }
				},
			})

			const failing = defineSeeder({
				name: 'failing',
				dependsOn: [first],
				run: () => {
					throw new Error('later failure')
				},
			})

			const run = await runSeeders([first, failing], { verbose: false, printResults: false })
			expect(run.success).toBe(false)
			expect(written.sort()).toEqual(['first:step-a', 'first:step-b'])
			expect(events).toEqual(['flushCache', 'onAfterAll'])
		})
	})

	describe('validation and safety', () => {
		const memoryCache = () => {
			const store = new Map<string, unknown>()
			const cache: SeederCache = {
				get: (key) => store.get(key),
				set: (key, value) => {
					store.set(key, value)
				},
			}
			return { store, cache }
		}

		it('should throw on a missing dependency before any hook runs', async () => {
			const beforeAll = mock(async () => {})
			const { defineSeeder, runSeeders } = createSeederInstance({
				onBeforeAll: beforeAll,
			})
			const seeder = defineSeeder({ name: 'a', run: async () => ({}) })
			const broken: Seeder<BaseSeederContext>[] = [{ ...seeder, dependsOn: ['ghost'] }]

			await expect(runSeeders(broken, { verbose: false })).rejects.toThrow(MissingDependencyError)
			expect(beforeAll).not.toHaveBeenCalled()
			expect(isSeedingActive()).toBe(false)
		})

		it('should keep seeding flag false during target evaluation', async () => {
			let activeDuringTarget: boolean | undefined
			const { defineSeeder, runSeeders } = createSeederInstance({
				target: () => {
					activeDuringTarget = isSeedingActive()
					return 'postgresql://localhost:5432/app'
				},
			})
			const seeder = defineSeeder({ name: 'a', run: () => ({}) })

			await runSeeders([seeder], { verbose: false, printResults: false })
			expect(activeDuringTarget).toBe(false)
		})

		it('should clear the seeding flag when onBeforeAll throws', async () => {
			const { defineSeeder, runSeeders } = createSeederInstance({
				onBeforeAll: () => {
					throw new Error('cannot connect')
				},
			})
			const seeder = defineSeeder({ name: 'a', run: async () => ({}) })

			await expect(runSeeders([seeder], { verbose: false })).rejects.toThrow('cannot connect')
			expect(isSeedingActive()).toBe(false)
		})

		it('should call onBeforeAll before preloadCache and the context factory', async () => {
			const calls: string[] = []
			const { defineSeeder, runSeeders } = createSeederInstance({
				cache: {
					get: () => undefined,
					set: () => {},
					getAll: () => {
						calls.push('preloadCache')
						return new Map()
					},
				},
				context: (base) => {
					calls.push('context')
					return base
				},
				onBeforeAll: () => {
					calls.push('onBeforeAll')
				},
			})
			const seeder = defineSeeder({ name: 'a', run: async () => ({}) })

			await runSeeders([seeder], { verbose: false, printResults: false })
			expect(calls).toEqual(['onBeforeAll', 'preloadCache', 'context'])
		})

		it('should refuse a remote target unless allowRemote is set', async () => {
			const context = mock((base: BaseSeederContext) => base)
			const { defineSeeder, runSeeders } = createSeederInstance({
				context,
				target: () => 'postgresql://admin:secret@db.example.com:5432/app',
			})
			const seeder = defineSeeder({ name: 'a', run: async () => ({}) })

			const refused = runSeeders([seeder], { verbose: false })
			await expect(refused).rejects.toThrow(SeedTargetError)
			await expect(refused).rejects.toThrow('db.example.com:5432/app')
			expect(context).not.toHaveBeenCalled()

			const { success } = await runSeeders([seeder], {
				verbose: false,
				printResults: false,
				allowRemote: true,
			})
			expect(success).toBe(true)
		})

		it('should describe targets without credentials and handle malformed host params safely', () => {
			expect(describeTarget('postgresql://u:pw@localhost:5432/hugsi')).toEqual({
				label: 'localhost:5432/hugsi',
				local: true,
			})
			expect(describeTarget('postgresql://u:pw@postgres:5432/app').local).toBe(true)
			expect(describeTarget('postgresql://u@127.0.0.1/app').local).toBe(true)
			expect(describeTarget('postgresql://u@[::1]:5432/app').local).toBe(true)
			expect(describeTarget('postgresql://u@host.docker.internal/app').local).toBe(true)
			expect(describeTarget('postgresql://u@postgres.railway.internal/app').local).toBe(false)
			expect(describeTarget('not a url').local).toBe(false)
			expect(describeTarget('postgresql://u@localhost/db?host=prod.example.com').local).toBe(false)
			expect(describeTarget('postgresql://u@localhost/db?host=%E0%A4%A').local).toBe(false)
			expect(describeTarget('postgresql://u:p@/db?host=/var/run/postgresql').local).toBe(true)
			expect(describeTarget('sqlserver://localhost:1433;database=x;password=pw')).toEqual({
				label: 'localhost:1433',
				local: true,
			})
			expect(describeTarget('mongodb://u:p@localhost:27017,localhost:27018/db').local).toBe(true)
			expect(describeTarget('mongodb://u:p@localhost:27017,db.example.com/db').local).toBe(false)
			expect(describeTarget('jdbc:postgresql://prod.example.com/db').local).toBe(false)
			expect(describeTarget('prod.example.com:5432/db').local).toBe(false)
			expect(describeTarget('file:./dev.db').local).toBe(true)
		})

		it('should respect NO_COLOR in colorize', () => {
			const prevNoColor = process.env.NO_COLOR
			const prevForceColor = process.env.FORCE_COLOR
			try {
				process.env.FORCE_COLOR = '1'
				delete process.env.NO_COLOR
				expect(colorize('hello', 'red')).toContain('\x1b[31m')

				process.env.NO_COLOR = '1'
				expect(colorize('hello', 'red')).toBe('hello')
			} finally {
				if (prevNoColor === undefined) delete process.env.NO_COLOR
				else process.env.NO_COLOR = prevNoColor
				if (prevForceColor === undefined) delete process.env.FORCE_COLOR
				else process.env.FORCE_COLOR = prevForceColor
			}
		})

		it('should record the failed step and the cached steps before it', async () => {
			const { cache } = memoryCache()
			const { defineSeeder, runSeeders } = createSeederInstance({
				cache,
			})
			let fail = false
			const seeder = defineSeeder({
				name: 'orderSeeder',
				run: async ({ step }) => {
					await step('Create customer', () => 'c1', { useCache: true })
					await step('Create order', () => {
						if (fail) throw new Error('order failed', { cause: new Error('root cause') })
						return 'o1'
					})
					return {}
				},
			})

			await runSeeders([seeder], { verbose: false, printResults: false })
			fail = true
			const log = spyOn(console, 'log')
			log.mockClear()
			const { results } = await runSeeders([seeder], { verbose: false })

			const first = results[0]
			expect(first?.status).toBe('failed')
			if (first?.status === 'failed') {
				expect(first.failedStep).toBe('Create order')
				expect(first.cachedSteps).toEqual(['Create customer'])
			}
			const printed = log.mock.calls.flat().map(String).join('\n')
			expect(printed).toContain('failed in step "Create order"')
			expect(printed).toContain('root cause')
			expect(printed).toContain('--only orderSeeder --fresh')
		})

		it('should run only the selected seeders and their dependencies, fresh where asked', async () => {
			const { store, cache } = memoryCache()
			const ran: string[] = []
			const { defineSeeder, runSeeders } = createSeederInstance({
				cache,
			})
			const user = defineSeeder({
				name: 'user',
				run: async ({ step }) => {
					ran.push('user')
					return step('Create user', () => `user-${ran.length}`, { useCache: true })
				},
			})
			const post = defineSeeder({
				name: 'post',
				dependsOn: [user],
				run: async ({ step }, deps) => {
					ran.push('post')
					return step('Create post', () => `post-of-${deps.user}`, { useCache: true })
				},
			})
			const other = defineSeeder({ name: 'other', run: async () => ran.push('other') })
			const all = [other, post, user] as const

			const partialRun = await runSeeders(all, {
				verbose: false,
				printResults: false,
				only: ['post'],
			})
			expect(ran).toEqual(['user', 'post'])
			if (partialRun.success) {
				expect(partialRun.outputs.post).toBe('post-of-user-1')
				expect(partialRun.outputs.other).toBeUndefined()
			}

			await runSeeders(all, {
				verbose: false,
				printResults: false,
				only: ['post'],
				fresh: ['post'],
			})
			// user replayed its cache; post ran fresh and overwrote its entry
			expect(store.get('user:create-user')).toEqual({ __plantr: 1, value: 'user-1' })
			expect(store.get('post:create-post')).toEqual({ __plantr: 1, value: 'post-of-user-1' })

			await expect(
				runSeeders(all, {
					verbose: false,
					// @ts-expect-error testing runtime UnknownSeederError for an unregistered name
					only: ['ghost'],
				}),
			).rejects.toThrow(UnknownSeederError)
		})

		it('should seed faker per seeder when fakerSeed is set', async () => {
			const names: string[] = []
			const { defineSeeder, runSeeders } = createSeederInstance({
				fakerSeed: 1,
			})
			const seeder = defineSeeder({
				name: 'fakeSeeder',
				run: async ({ faker }) => names.push(faker.person.fullName()),
			})

			await runSeeders([seeder], { verbose: false, printResults: false })
			await runSeeders([seeder], { verbose: false, printResults: false })
			expect(names[0]).toBe(names[1])
		})
	})

	describe('runCli', () => {
		const setup = () => {
			const ran: string[] = []
			const { defineSeeder, runSeeders } = createSeederInstance({
				target: () => 'postgresql://localhost:5432/testdb',
			})
			const user = defineSeeder({
				name: 'user',
				description: 'Creates test users',
				run: async () => ran.push('user'),
			})
			const post = defineSeeder({
				name: 'post',
				description: 'Creates posts for users',
				dependsOn: [user],
				run: async () => ran.push('post'),
			})
			const other = defineSeeder({ name: 'other', run: async () => ran.push('other') })
			const cli = (...argv: string[]) =>
				runCli(
					[user, post, other],
					(s, opts) => runSeeders(s as [typeof user, typeof post, typeof other], opts as never),
					{ name: 'Test', argv, target: () => 'postgresql://localhost:5432/testdb' },
				)
			return { ran, cli }
		}

		it('should run named seeders with their dependencies and print only one banner', async () => {
			const log = spyOn(console, 'log')
			log.mockClear()
			const { ran, cli } = setup()
			expect(await cli('post')).toBe(0)
			expect(ran).toEqual(['user', 'post'])
			const banners = log.mock.calls.flat().filter((line) => String(line).includes('🌱 Running'))
			expect(banners).toHaveLength(1)
		})

		it('should accept --only, --continue-on-failure, --concurrency, and --quiet', async () => {
			const { ran, cli } = setup()
			expect(
				await cli('--only', 'other,user', '--continue-on-failure', '--concurrency', '2', '--quiet'),
			).toBe(0)
			expect(ran.sort()).toEqual(['other', 'user'])
		})

		it('should exit 1 on an unknown flag, invalid concurrency, or unknown seeder without running anything', async () => {
			const { ran, cli } = setup()
			expect(await cli('--fersh')).toBe(1)
			expect(await cli('--concurrency', '0')).toBe(1)
			expect(await cli('--concurrency', 'abc')).toBe(1)
			expect(await cli('all')).toBe(1)
			expect(ran).toEqual([])
		})

		it('should show registered seeders in --help and --list, and target + fresh in --dry-run', async () => {
			const log = spyOn(console, 'log')
			const { ran, cli } = setup()

			log.mockClear()
			expect(await cli('--help')).toBe(0)
			const helpOut = log.mock.calls.flat().map(String).join('\n')
			expect(helpOut).toContain('Registered seeders (3):')
			expect(helpOut).toContain('Creates test users')

			log.mockClear()
			expect(await cli('--list')).toBe(0)
			const listOut = log.mock.calls.flat().map(String).join('\n')
			expect(listOut).toContain('user')
			expect(listOut).toContain('[depends on: user]')

			log.mockClear()
			expect(await cli('--dry-run', 'post', '--fresh')).toBe(0)
			const dryOut = log.mock.calls.flat().map(String).join('\n')
			expect(dryOut).toContain('localhost:5432/testdb')
			expect(dryOut).toContain('Creates posts for users')
			expect(dryOut).toContain('(fresh)')

			log.mockClear()
			expect(await cli('--dry-run', '--concurrency', '4')).toBe(0)
			const waveOut = log.mock.calls.flat().map(String).join('\n')
			expect(waveOut).toContain('Execution plan (2 waves):')
			expect(waveOut).toContain('Wave 1')
			expect(waveOut).toContain('(parallel)')
			expect(waveOut).toContain('Wave 2')

			expect(ran).toEqual([])
		})
	})
})
