import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { join } from 'node:path'
import { runCli } from './cli.js'
import { createSeederInstance } from './create-seeder-instance.js'
import type { FreshRun } from './run-seeders.js'
import { isSeedingActive, setSeedingActive } from './seeding-state.js'
import type { SeederCache } from './step.js'

const quiet = { printResults: false, verbose: false } as const

describe('setup and teardown', () => {
	beforeEach(() => {
		setSeedingActive(false)
		spyOn(console, 'log').mockImplementation(() => {})
		spyOn(console, 'error').mockImplementation(() => {})
	})

	it('passes the resources setup returns to the context factory and teardown, in lifecycle order', async () => {
		const events: string[] = []
		const store = new Map<string, unknown>()
		const cache: SeederCache = {
			get: (key) => store.get(key),
			set: (key, value) => {
				store.set(key, value)
			},
			setMany: (entries) => {
				events.push(`flush ${entries.length}`)
			},
		}
		const { defineSeeder, runSeeders } = createSeederInstance({
			cache,
			onBeforeAll: () => {
				events.push('onBeforeAll')
			},
			setup: () => {
				events.push('setup')
				return { db: 'connection' as const }
			},
			context: (_base, { db }) => {
				events.push(`context ${db}`)
				return { db }
			},
			onAfterAll: (ctx) => {
				events.push(`onAfterAll ${ctx?.db}`)
			},
			teardown: ({ db }) => {
				events.push(`teardown ${db}`)
			},
		})
		const seeder = defineSeeder({
			name: 'a',
			run: async ({ db, step }) => {
				await step('Write', () => events.push(`seed ${db}`), { useCache: true })
			},
		})

		const run = await runSeeders([seeder], quiet)

		expect(run.success).toBe(true)
		expect(events).toEqual([
			'onBeforeAll',
			'setup',
			'context connection',
			'seed connection',
			'flush 1',
			'onAfterAll connection',
			'teardown connection',
		])
		expect(isSeedingActive()).toBe(false)
	})

	it('tears down when a seeder fails', async () => {
		const torn: string[] = []
		const { defineSeeder, runSeeders } = createSeederInstance({
			setup: () => ({ db: 'db' }),
			teardown: ({ db }) => {
				torn.push(db)
			},
		})
		const seeder = defineSeeder({
			name: 'a',
			run: () => {
				throw new Error('seeder boom')
			},
		})

		const run = await runSeeders([seeder], quiet)

		expect(run.success).toBe(false)
		expect(torn).toEqual(['db'])
	})

	it('tears down with the resources when the context factory throws', async () => {
		const torn: string[] = []
		const { defineSeeder, runSeeders } = createSeederInstance({
			setup: () => ({ db: 'db' }),
			context: () => {
				throw new Error('context boom')
			},
			teardown: ({ db }) => {
				torn.push(db)
			},
		})
		const seeder = defineSeeder({ name: 'a', run: () => 1 })

		await expect(runSeeders([seeder], quiet)).rejects.toThrow('context boom')
		expect(torn).toEqual(['db'])
		expect(isSeedingActive()).toBe(false)
	})

	it('runs deferred cleanups, last first, when setup throws after acquiring part of its resources', async () => {
		const events: string[] = []
		let tornDown = false
		const { defineSeeder, runSeeders } = createSeederInstance({
			setup: ({ defer }) => {
				events.push('open db')
				defer(() => {
					events.push('close db')
				})
				events.push('open client')
				defer(async () => {
					events.push('close client')
				})
				throw new Error('sign-in failed')
			},
			teardown: () => {
				tornDown = true
			},
		})
		const seeder = defineSeeder({ name: 'a', run: () => events.push('seeded') })

		await expect(runSeeders([seeder], quiet)).rejects.toThrow('sign-in failed')
		expect(events).toEqual(['open db', 'open client', 'close client', 'close db'])
		expect(tornDown).toBe(false)
		expect(isSeedingActive()).toBe(false)
	})

	it('runs deferred cleanups after teardown on a successful run', async () => {
		const events: string[] = []
		const { defineSeeder, runSeeders } = createSeederInstance({
			setup: ({ defer }) => {
				defer(() => {
					events.push('deferred')
				})
				return 'resources'
			},
			teardown: (resources) => {
				events.push(`teardown ${resources}`)
			},
		})
		const seeder = defineSeeder({ name: 'a', run: () => 1 })

		await runSeeders([seeder], quiet)
		expect(events).toEqual(['teardown resources', 'deferred'])
	})

	it('does not set up when onBeforeAll refuses the run', async () => {
		let setUp = false
		const { defineSeeder, runSeeders } = createSeederInstance({
			onBeforeAll: () => {
				throw new Error('refused')
			},
			setup: () => {
				setUp = true
			},
		})
		const seeder = defineSeeder({ name: 'a', run: () => 1 })

		await expect(runSeeders([seeder], quiet)).rejects.toThrow('refused')
		expect(setUp).toBe(false)
	})

	it('throws a teardown error after a successful run, and keeps the first error when the run already threw', async () => {
		const failingTeardown = createSeederInstance({
			setup: () => 'db',
			teardown: () => {
				throw new Error('close failed')
			},
		})
		const ok = failingTeardown.defineSeeder({ name: 'a', run: () => 1 })
		await expect(failingTeardown.runSeeders([ok], quiet)).rejects.toThrow('close failed')

		const error = spyOn(console, 'error')
		error.mockClear()
		const both = createSeederInstance({
			setup: () => 'db',
			context: () => {
				throw new Error('context boom')
			},
			teardown: () => {
				throw new Error('close failed')
			},
		})
		const seeder = both.defineSeeder({ name: 'a', run: () => 1 })
		await expect(both.runSeeders([seeder], quiet)).rejects.toThrow('context boom')
		const printed = error.mock.calls.flat().map(String).join('\n')
		expect(printed).toContain('Cleanup after the run also failed')
		expect(printed).toContain('close failed')
	})

	it('stops listening for signals once the run ends', async () => {
		const before = process.listenerCount('SIGINT')
		let during = 0
		const { defineSeeder, runSeeders } = createSeederInstance()
		const seeder = defineSeeder({
			name: 'a',
			run: () => {
				during = process.listenerCount('SIGINT')
			},
		})

		await runSeeders([seeder], quiet)
		expect(during).toBe(before + 1)
		expect(process.listenerCount('SIGINT')).toBe(before)

		await runSeeders([seeder], { ...quiet, handleSignals: false })
		expect(during).toBe(before)
	})
})

describe('cache factory', () => {
	beforeEach(() => {
		setSeedingActive(false)
		spyOn(console, 'log').mockImplementation(() => {})
		spyOn(console, 'error').mockImplementation(() => {})
	})

	const storeFor = (store: Map<string, unknown>, calls: string[]): SeederCache => ({
		get: (key) => store.get(key),
		set: (key, value) => {
			store.set(key, value)
		},
		getAll: () => {
			calls.push('getAll')
			return store
		},
		setMany: (entries) => {
			calls.push(`setMany ${entries.length}`)
			for (const { key, value } of entries) store.set(key, value)
		},
	})

	it('builds the cache from the resources after setup, once per run, and replays it on the next run', async () => {
		const store = new Map<string, unknown>()
		const calls: string[] = []
		let runs = 0
		const { defineSeeder, runSeeders } = createSeederInstance({
			setup: () => {
				calls.push('setup')
				return { store }
			},
			cache: (resources) => {
				calls.push('cache')
				return storeFor(resources.store, calls)
			},
			teardown: () => {
				calls.push('teardown')
			},
		})
		const seeder = defineSeeder({
			name: 'a',
			run: ({ step }) => step('Create', () => ++runs, { useCache: true }),
		})

		const first = await runSeeders([seeder], quiet)
		const second = await runSeeders([seeder], quiet)

		expect(first.success && first.outputs.a).toBe(1)
		expect(second.success && second.outputs.a).toBe(1)
		expect(runs).toBe(1)
		expect(second.success && second.results[0]?.status === 'completed').toBe(true)
		expect(calls).toEqual([
			'setup',
			'cache',
			'getAll',
			'setMany 1',
			'teardown',
			'setup',
			'cache',
			'getAll',
			'teardown',
		])
	})

	it('accepts an async factory and runs without a cache when it returns undefined', async () => {
		let runs = 0
		const { defineSeeder, runSeeders } = createSeederInstance({
			cache: async () => undefined,
		})
		const seeder = defineSeeder({
			name: 'a',
			run: ({ step }) => step('Create', () => ++runs, { useCache: true }),
		})

		await runSeeders([seeder], quiet)
		await runSeeders([seeder], quiet)
		expect(runs).toBe(2)
	})

	it('tears down when the cache factory throws', async () => {
		const torn: string[] = []
		const { defineSeeder, runSeeders } = createSeederInstance({
			setup: () => ({ db: 'db' }),
			cache: () => {
				throw new Error('no cache collection')
			},
			teardown: ({ db }) => {
				torn.push(db)
			},
		})
		const seeder = defineSeeder({ name: 'a', run: () => 1 })

		await expect(runSeeders([seeder], quiet)).rejects.toThrow('no cache collection')
		expect(torn).toEqual(['db'])
	})
})

describe('onFresh', () => {
	beforeEach(() => {
		setSeedingActive(false)
		spyOn(console, 'log').mockImplementation(() => {})
		spyOn(console, 'error').mockImplementation(() => {})
	})

	const build = () => {
		const events: string[] = []
		const freshRuns: Omit<FreshRun<{ db: string }>, 'resources'>[] = []
		const store = new Map<string, unknown>()
		const instance = createSeederInstance({
			setup: () => ({ db: 'emulator' }),
			cache: () => ({
				get: (key) => store.get(key),
				set: (key, value) => {
					store.set(key, value)
				},
				getAll: () => {
					events.push('preload')
					return store
				},
			}),
			onFresh: ({ resources, seeders, all }) => {
				events.push(`onFresh ${resources.db}`)
				freshRuns.push({ seeders, all })
				if (all) store.clear()
			},
			context: () => {
				events.push('context')
				return {}
			},
			teardown: () => {
				events.push('teardown')
			},
		})
		const user = instance.defineSeeder({
			name: 'user',
			run: ({ step }) => step('Create user', () => events.push('user created'), { useCache: true }),
		})
		const post = instance.defineSeeder({
			name: 'post',
			dependsOn: [user],
			run: ({ step }) => step('Create post', () => events.push('post created'), { useCache: true }),
		})
		const other = instance.defineSeeder({ name: 'other', run: () => {} })
		const seeders = [user, post, other] as const
		const cli = (...argv: string[]) =>
			runCli(seeders, (s, opts) => instance.runSeeders(s as typeof seeders, opts as never), {
				name: 'Test',
				argv,
			})
		return { events, freshRuns, instance, seeders, cli }
	}

	it('resets before the cache preload and the context factory when every seeder runs fresh', async () => {
		const { events, freshRuns, instance, seeders } = build()
		await instance.runSeeders(seeders, quiet)
		events.length = 0

		await instance.runSeeders(seeders, { ...quiet, fresh: true })

		expect(freshRuns).toEqual([{ seeders: ['user', 'other', 'post'], all: true }])
		expect(events).toEqual([
			'onFresh emulator',
			'preload',
			'context',
			'user created',
			'post created',
			'teardown',
		])
	})

	it('does not run without fresh, or when no seeder of the run is fresh', async () => {
		const { freshRuns, instance, seeders } = build()
		await instance.runSeeders(seeders, quiet)
		await instance.runSeeders(seeders, { ...quiet, only: ['other'], fresh: ['post'] })
		expect(freshRuns).toEqual([])
	})

	it('reports a partial fresh run with all: false, whose dependencies replay their cache', async () => {
		const { events, freshRuns, instance, seeders } = build()
		await instance.runSeeders(seeders, quiet)
		events.length = 0

		await instance.runSeeders(seeders, { ...quiet, only: ['post'], fresh: ['post'] })

		expect(freshRuns).toEqual([{ seeders: ['post'], all: false }])
		expect(events).toContain('post created')
		expect(events).not.toContain('user created')

		// fresh: true with only is still partial: seeders outside the selection keep their cache
		await instance.runSeeders(seeders, { ...quiet, only: ['post'], fresh: true })
		expect(freshRuns[1]).toEqual({ seeders: ['user', 'post'], all: false })
	})

	it('maps CLI --fresh to all: true, and --fresh with names to those seeders', async () => {
		const { freshRuns, cli } = build()
		expect(await cli('--fresh', '--quiet')).toBe(0)
		expect(await cli('post', '--fresh', '--quiet')).toBe(0)
		expect(freshRuns).toEqual([
			{ seeders: ['user', 'other', 'post'], all: true },
			{ seeders: ['post'], all: false },
		])
	})

	it('tears down and seeds nothing when onFresh throws', async () => {
		const events: string[] = []
		const { defineSeeder, runSeeders } = createSeederInstance({
			setup: () => 'db',
			onFresh: () => {
				throw new Error('only all-fresh runs can reset')
			},
			teardown: () => {
				events.push('teardown')
			},
		})
		const seeder = defineSeeder({ name: 'a', run: () => events.push('seeded') })

		await expect(runSeeders([seeder], { ...quiet, fresh: true })).rejects.toThrow(
			'only all-fresh runs can reset',
		)
		expect(events).toEqual(['teardown'])
	})
})

describe('termination signals', () => {
	const fixture = join(import.meta.dir, 'fixtures', 'signal-run.mjs')
	const plantr = join(import.meta.dir, '..', 'index.ts')

	const runUntilSignal = async (signal: 'SIGINT' | 'SIGTERM', mode?: string, times = 1) => {
		const child = Bun.spawn([process.execPath, fixture, plantr, ...(mode ? [mode] : [])], {
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const reader = child.stdout.getReader()
		const decoder = new TextDecoder()
		let stdout = ''
		const waitFor = async (line: string) => {
			while (!stdout.includes(line)) {
				const { value, done } = await reader.read()
				if (done) throw new Error(`Exited before printing "${line}": ${stdout}`)
				stdout += decoder.decode(value)
			}
		}
		await waitFor('ready')
		child.kill(signal)
		if (times > 1) {
			await waitFor('teardown hangs')
			child.kill(signal)
		}
		const exitCode = await child.exited
		for (;;) {
			const { value, done } = await reader.read()
			if (done) break
			stdout += decoder.decode(value)
		}
		return { exitCode, lines: stdout.trim().split('\n') }
	}

	it('tears down, runs deferred cleanups and exits 130 on SIGINT', async () => {
		const { exitCode, lines } = await runUntilSignal('SIGINT')
		expect(lines).toEqual(['ready', 'teardown connected', 'deferred'])
		expect(exitCode).toBe(130)
	})

	it('tears down and exits 143 on SIGTERM', async () => {
		const { exitCode, lines } = await runUntilSignal('SIGTERM')
		expect(lines).toEqual(['ready', 'teardown connected', 'deferred'])
		expect(exitCode).toBe(143)
	})

	it('exits at once on a second signal while teardown hangs', async () => {
		const { exitCode, lines } = await runUntilSignal('SIGINT', 'hang-teardown', 2)
		expect(lines).toEqual(['ready', 'teardown hangs'])
		expect(exitCode).toBe(130)
	})
})
