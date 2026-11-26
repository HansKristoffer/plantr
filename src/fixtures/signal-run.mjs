// A run that waits in its first seeder until the parent process sends SIGINT or SIGTERM.
// Usage: <runtime> signal-run.mjs <plantr module specifier or path> [hang-teardown]
// Prints each lifecycle event on stdout, so the parent can check what ran before the exit.
const [specifier, mode] = process.argv.slice(2)
const { createSeederInstance } = await import(specifier)

const { defineSeeder, runSeeders } = createSeederInstance({
	setup: ({ defer }) => {
		defer(() => console.log('deferred'))
		return { db: 'connected' }
	},
	teardown: async ({ db }) => {
		if (mode === 'hang-teardown') {
			console.log('teardown hangs')
			await new Promise(() => setInterval(() => {}, 1000))
		}
		await new Promise((resolve) => setTimeout(resolve, 20))
		console.log(`teardown ${db}`)
	},
})

const waiting = defineSeeder({
	name: 'waiting',
	run: () => {
		console.log('ready')
		// The interval keeps the event loop alive until the signal arrives
		return new Promise(() => setInterval(() => {}, 1000))
	},
})
const after = defineSeeder({
	name: 'after',
	dependsOn: [waiting],
	run: () => console.log('after ran'),
})

await runSeeders([waiting, after], { verbose: false, printResults: false })
console.log('run returned')
