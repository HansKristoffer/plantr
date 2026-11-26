import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createSeederInstance } from './create-seeder-instance.js'
import type { SeederCache } from './step.js'

const quiet = { printResults: false, verbose: false } as const

const memoryCache = (): SeederCache => {
	const store = new Map<string, unknown>()
	return {
		get: (key) => store.get(key),
		set: (key, value) => {
			store.set(key, value)
		},
	}
}

/** A seeder whose first step is cached, with draws inside it, between steps, and in a later step */
const buildInstance = (fakerSeedScope?: 'seeder' | 'step') => {
	const { defineSeeder, runSeeders } = createSeederInstance({
		cache: memoryCache(),
		fakerSeed: 1,
		fakerSeedScope,
	})
	const seeder = defineSeeder({
		name: 'people',
		run: async ({ faker, step }) => {
			const cached = await step('Create owner', () => faker.person.fullName(), { useCache: true })
			const between = faker.person.fullName()
			const later = await step('Create guest', () => faker.person.fullName())
			return { cached, between, later }
		},
	})
	return { seeder, runSeeders }
}

describe('fakerSeedScope', () => {
	beforeEach(() => {
		spyOn(console, 'log').mockImplementation(() => {})
	})

	it("'step' keeps draws after a cached step the same as when the step ran", async () => {
		const { seeder, runSeeders } = buildInstance('step')
		const ran = await runSeeders([seeder], quiet)
		const replayed = await runSeeders([seeder], quiet)

		if (!ran.success || replayed.results[0]?.status !== 'completed') throw new Error('run failed')

		expect(replayed.results[0].cachedSteps).toEqual(['Create owner'])
		expect(replayed.results[0].output).toEqual(ran.outputs.people)
		expect(new Set(Object.values(ran.outputs.people)).size).toBe(3)
	})

	it("'seeder' (the default) keeps 2.2 behaviour: a cached step shifts later draws", async () => {
		for (const scope of [undefined, 'seeder'] as const) {
			const { seeder, runSeeders } = buildInstance(scope)
			const ran = await runSeeders([seeder], quiet)
			const replayed = await runSeeders([seeder], quiet)
			if (!ran.success || !replayed.success) throw new Error('run failed')
			expect(replayed.outputs.people.cached).toBe(ran.outputs.people.cached)
			expect(replayed.outputs.people.between).not.toBe(ran.outputs.people.between)
			// What the step drew on the first run is what the body draws when it is cached
			expect(replayed.outputs.people.between).toBe(ran.outputs.people.cached)
		}
	})

	it("'step' generates the same data in a new instance, and different data per step key", async () => {
		const first = buildInstance('step')
		const second = buildInstance('step')
		const a = await first.runSeeders([first.seeder], quiet)
		const b = await second.runSeeders([second.seeder], quiet)
		if (!a.success || !b.success) throw new Error('run failed')
		expect(b.outputs.people).toEqual(a.outputs.people)
		expect(a.outputs.people.cached).not.toBe(a.outputs.people.later)
	})

	it("'step' gives repeated keys their own sequence, and parallel steps the same data whatever finishes first", async () => {
		const draws: string[][] = []
		for (const delays of [
			[5, 0],
			[0, 5],
		]) {
			const { defineSeeder, runSeeders } = createSeederInstance({
				fakerSeed: 1,
				fakerSeedScope: 'step',
			})
			const seeder = defineSeeder({
				name: 'parallel',
				run: async ({ faker, step }) => {
					const repeated = []
					for (let i = 0; i < 2; i++) {
						repeated.push(await step('Create user', () => faker.person.fullName()))
					}
					const parallel = await Promise.all(
						delays.map((delay, index) =>
							step(`Create team ${index}`, async () => {
								const first = faker.word.noun()
								await new Promise((resolve) => setTimeout(resolve, delay))
								return `${first} ${faker.word.noun()}`
							}),
						),
					)
					return [...repeated, ...parallel]
				},
			})
			const run = await runSeeders([seeder], quiet)
			if (!run.success) throw new Error('run failed')
			draws.push(run.outputs.parallel)
		}

		expect(draws[0]).toEqual(draws[1]!)
		expect(draws[0]?.[0]).not.toBe(draws[0]?.[1])
	})

	it("'step' isolates steps in concurrent seeders too", async () => {
		const outputs: unknown[] = []
		for (const concurrency of [1, 2]) {
			const { defineSeeder, runSeeders } = createSeederInstance({
				fakerSeed: 3,
				fakerSeedScope: 'step',
				concurrency,
			})
			const make = (name: string) =>
				defineSeeder({
					name,
					run: ({ faker, step }) => step('Draw', () => faker.string.alphanumeric(12)),
				})
			const run = await runSeeders([make('a'), make('b')], quiet)
			if (!run.success) throw new Error('run failed')
			outputs.push(run.outputs)
		}
		expect(outputs[0]).toEqual(outputs[1])
	})
})
