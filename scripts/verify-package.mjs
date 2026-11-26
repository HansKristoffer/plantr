import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Pack and install the actual consumer artifact. Keep those exact bytes for publishing.
const root = process.cwd()
const temporary = mkdtempSync(join(tmpdir(), 'package-consumer-'))
const artifacts = resolve('.artifacts')
mkdirSync(artifacts, { recursive: true })
rmSync(join(artifacts, 'package.tgz'), { force: true })
rmSync(join(artifacts, 'package.json'), { force: true })

try {
	const [packed] = JSON.parse(
		execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], {
			cwd: root,
			encoding: 'utf8',
		}),
	)
	const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
	const files = new Set(packed.files.map(({ path }) => path))
	assert.ok(
		[...files].some((file) => /^readme\.md$/i.test(file)),
		'Package needs a README',
	)
	assert.ok(files.has('LICENSE'), 'Package needs its declared license')
	for (const file of files) {
		assert.ok(
			!/\.(test|testing)\.[cm]?[jt]s$|\.tsbuildinfo$|\.tgz$/.test(file),
			`Unwanted package file: ${file}`,
		)
		assert.ok(
			!file.startsWith('docs/') && !file.startsWith('.github/'),
			`Unwanted package file: ${file}`,
		)
	}
	const targets = (value) =>
		typeof value === 'string' ? [value] : Object.values(value).flatMap(targets)
	for (const file of targets(pkg.exports)) {
		if (file.startsWith('./')) assert.ok(files.has(file.slice(2)), `Missing export: ${file}`)
	}
	for (const file of Object.values(pkg.bin || {}))
		assert.ok(files.has(file.replace(/^\.\//, '')), `Missing binary: ${file}`)
	writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
	execFileSync(
		'npm',
		['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed.filename)],
		{
			cwd: temporary,
			stdio: 'pipe',
			timeout: 120_000,
		},
	)
	const specifiers = Object.keys(pkg.exports)
		.filter((key) => key !== './package.json')
		.map((key) => pkg.name + (key === '.' ? '' : key.slice(1)))
	const code = `for (const name of ${JSON.stringify(specifiers)}) await import(name); console.log('Verified package imports');`
	const runtime = pkg.name === 'expo-release' ? 'bun' : process.execPath
	execFileSync(runtime, ['--input-type=module', '-e', code], {
		cwd: temporary,
		stdio: 'inherit',
		timeout: 30_000,
	})
	if (pkg.name === 'plantr') {
		// Ensure built dist artifacts are completely free of hard Bun-only imports/references
		const distIndexJs = readFileSync(join(temporary, 'node_modules/plantr/dist/index.js'), 'utf8')
		const distStateJs = readFileSync(join(temporary, 'node_modules/plantr/dist/state.js'), 'utf8')
		assert.ok(
			!/from\s+["']bun:test["']|import\(["']bun:test["']\)/.test(distIndexJs),
			'dist/index.js must not statically import bun:test',
		)
		assert.ok(
			!/\bBun\.inspect\b/.test(distIndexJs),
			'dist/index.js must not call Bun.inspect unconditionally',
		)
		assert.ok(
			!distStateJs.includes('@faker-js/faker') && !distStateJs.includes('bun:test'),
			'dist/state.js must stay lightweight without faker or bun:test',
		)

		// Ensure emitted .d.ts declarations do not require @types/bun or bun:test
		for (const file of files) {
			if (file.endsWith('.d.ts')) {
				const dts = readFileSync(join(temporary, 'node_modules/plantr', file), 'utf8')
				assert.ok(
					!dts.includes("'bun:test'") && !dts.includes('"bun:test"'),
					`Declaration ${file} must not reference bun:test`,
				)
			}
		}

		// Real Node.js smoke test covering dist/index.js + dist/state.js end-to-end
		const nodeSmokeFile = join(temporary, 'node-smoke.mjs')
		writeFileSync(
			nodeSmokeFile,
			`import assert from 'node:assert/strict'
import { createSeederInstance, describeTarget, expect, faker, SeedTargetError } from 'plantr'
import { isSeedingActive } from 'plantr/state'

// Top-level runtime-safe expect + lazy faker
expect(faker.person.fullName().length).toBeGreaterThan(0)
expect({ a: 1, b: undefined }).toEqual({ a: 1 })
expect({ a: 1, b: undefined }).not.toStrictEqual({ a: 1 })
expect('plantr-node').toContain('node')
expect([1, 2, 3]).toHaveLength(3)
expect('abc123').toMatch(/\\d+$/)
expect(10).toBeGreaterThanOrEqual(10)
expect(5).toBeLessThan(10)
expect(5).toBeLessThanOrEqual(5)
expect(null).toBeNull()
expect(undefined).toBeUndefined()
expect('ok').toBeDefined()
expect(1).toBeTruthy()
expect(0).toBeFalsy()
expect(() => { throw new TypeError('node boom') }).toThrow(TypeError)
expect(() => 'ok').not.toThrow()

// Step caching (getAll + setMany), fakerSeed, concurrency, shared plantr/state flag, and emulator target guard
const store = new Map()
let getAllCalls = 0
let setManyCalls = 0
const cache = {
	get: (key) => store.get(key),
	set: (key, value) => { store.set(key, value) },
	getAll: () => {
		getAllCalls++
		return store
	},
	setMany: (entries) => {
		setManyCalls++
		for (const { key, value } of entries) store.set(key, value)
	},
}

let activeInsideSeeder = false
const { defineSeeder, runSeeders } = createSeederInstance({
	cache,
	concurrency: 2,
	fakerSeed: 7,
	target: () => 'firestore://127.0.0.1:8080/demo-kanpla',
})

const userSeed = defineSeeder({
	name: 'user',
	run: async ({ faker: f, step, expect: exp }) => {
		activeInsideSeeder = isSeedingActive()
		const name = await step('Create user', () => f.person.fullName(), {
			useCache: true,
			key: 'admin-user',
			version: { v: 1 },
		})
		exp(name).toBeDefined()
		exp(name.length).toBeGreaterThan(0)
		return { name }
	},
})

const postSeed = defineSeeder({
	name: 'post',
	dependsOn: [userSeed],
	run: async ({ step, expect: exp }, deps) => {
		const title = await step('Create post', () => 'Post by ' + deps.user.name, { useCache: true })
		exp(title).toContain(deps.user.name)
		return { title }
	},
})

assert.equal(isSeedingActive(), false)
const run1 = await runSeeders([userSeed, postSeed], { verbose: false, printResults: false })
assert.equal(isSeedingActive(), false)
assert.equal(activeInsideSeeder, true)
assert.equal(run1.success, true)
assert.equal(getAllCalls, 1)
assert.equal(setManyCalls, 1)

// Second run replays cache via getAll without setMany writes
const run2 = await runSeeders([userSeed, postSeed], { verbose: false, printResults: false })
assert.equal(run2.success, true)
assert.deepEqual(run2.outputs, run1.outputs)
assert.equal(setManyCalls, 1)
assert.deepEqual(run2.results[0].cachedSteps, ['Create user'])

// Custom expect injection
let customExpectCalled = false
const customInst = createSeederInstance({
	expect: (val) => {
		customExpectCalled = true
		return { isOk: () => assert.equal(val, 'ok') }
	},
})
const customSeed = customInst.defineSeeder({
	name: 'custom',
	run: ({ expect: exp }) => {
		exp('ok').isOk()
		return true
	},
})
const customRun = await customInst.runSeeders([customSeed], { verbose: false, printResults: false })
assert.equal(customRun.success, true)
assert.equal(customExpectCalled, true)

// Failure formatting exercises node:util inspect fallback under Node (printResults: true)
const origLog = console.log
const logged = []
console.log = (...args) => logged.push(args.join(' '))
try {
	const failInst = createSeederInstance()
	const bad = failInst.defineSeeder({
		name: 'failing',
		run: async ({ step }) => {
			await step('Explode', () => {
				throw new Error('node failure', { cause: new Error('inner node cause') })
			})
		},
	})
	const failRun = await failInst.runSeeders([bad], { verbose: false, printResults: true })
	assert.equal(failRun.success, false)
	const output = logged.join('\\n')
	assert.ok(output.includes('node failure'), 'Failure output should include error message')
	assert.ok(output.includes('inner node cause'), 'Failure output should include error cause')
} finally {
	console.log = origLog
}

// Target guard checks under Node (emulator local vs remote/cloud)
assert.deepEqual(describeTarget('http://127.0.0.1:8080'), { label: '127.0.0.1:8080', local: true })
assert.deepEqual(describeTarget('http://localhost:8080'), { label: 'localhost:8080', local: true })
assert.deepEqual(describeTarget('firestore://127.0.0.1:8080/demo-kanpla'), {
	label: '127.0.0.1:8080/demo-kanpla',
	local: true,
})
assert.equal(describeTarget('https://firestore.googleapis.com').local, false)
assert.equal(describeTarget('firestore://kanpla-87be3').local, false)
assert.equal(describeTarget('kanpla-87be3').local, false)

const remoteInst = createSeederInstance({ target: () => 'firestore://kanpla-87be3' })
const noop = remoteInst.defineSeeder({ name: 'noop', run: () => 1 })
await assert.rejects(
	() => remoteInst.runSeeders([noop], { verbose: false, printResults: false }),
	SeedTargetError,
)
const allowed = await remoteInst.runSeeders([noop], {
	verbose: false,
	printResults: false,
	allowRemote: true,
})
assert.equal(allowed.success, true)

console.log('Verified plantr smoke test on Node.js ' + process.version)
`,
		)
		execFileSync(process.execPath, [nodeSmokeFile], {
			cwd: temporary,
			stdio: 'inherit',
			timeout: 30_000,
		})

		// Bun import + smoke test (verifies bun:test expect resolution on Bun)
		execFileSync('bun', ['--input-type=module', '-e', code], {
			cwd: temporary,
			stdio: 'inherit',
			timeout: 30_000,
		})
		execFileSync(
			'bun',
			[
				'-e',
				`import { expect as bunExpect } from 'bun:test'; import { createSeederInstance, expect, faker } from 'plantr'; import { isSeedingActive } from 'plantr/state'; const { defineSeeder, runSeeders } = createSeederInstance({ concurrency: 2, fakerSeed: 1 }); let usedBunExpect = false; const seed = defineSeeder({ name: 'smoke', run: async ({ expect: ctxExpect, faker: f }) => { usedBunExpect = ctxExpect === bunExpect; ctxExpect(f.person.fullName().length).toBeGreaterThan(0); expect(faker.person.fullName().length).toBeGreaterThan(0); ctxExpect(isSeedingActive()).toBe(true); return 1; } }); const result = await runSeeders([seed], { verbose: false, printResults: false }); if (!result.success || result.outputs.smoke !== 1 || !usedBunExpect || isSeedingActive()) process.exit(1); console.log('Verified plantr smoke test on Bun ' + Bun.version);`,
			],
			{ cwd: temporary, stdio: 'inherit', timeout: 30_000 },
		)

		// Verify emitted .d.ts files resolve cleanly in a pure Node consumer (WITHOUT @types/bun!)
		// under NodeNext and bundler + exactOptionalPropertyTypes without silently degrading to `any`.
		const tscBin = join(root, 'node_modules', '.bin', 'tsc')
		if (existsSync(tscBin)) {
			const consumerTypesDir = join(temporary, 'node_modules', '@types')
			mkdirSync(consumerTypesDir, { recursive: true })
			const nodeTypesDir = join(root, 'node_modules', '@types', 'node')
			if (existsSync(nodeTypesDir)) {
				symlinkSync(nodeTypesDir, join(consumerTypesDir, 'node'))
			}

			const typeCheckFile = join(temporary, 'consumer-types.ts')
			writeFileSync(
				typeCheckFile,
				`import { createSeederInstance, expect, type ExpectFn, type SeederCache } from 'plantr'
import { isSeedingActive } from 'plantr/state'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const assertType = <_T extends true>() => {}

assertType<Equal<typeof expect, ExpectFn>>()

const store = new Map<string, unknown>()
const cache: SeederCache = {
  get: (key) => store.get(key),
  set: (key, value) => { store.set(key, value) },
  getAll: () => store,
}

const { defineSeeder, runSeeders } = createSeederInstance({
  cache,
  context: () => ({ db: 'ok' as const }),
})

const user = defineSeeder({
  name: 'user',
  description: undefined,
  run: ({ db, expect: exp }) => {
    assertType<Equal<typeof exp, ExpectFn>>()
    exp(db).toBe('ok')
    exp(db).not.toBe('bad')
    return { id: db }
  },
})
const post = defineSeeder({
  name: 'post',
  dependsOn: [user],
  run: (_ctx, deps) => ({ author: deps.user.id }),
})

// Verify custom expect (e.g. Vitest-like) preserves its exact type
const customExpect = <T>(val: T) => ({
  toBe: (_expected: T) => {},
  toCustomMatch: () => true,
})
const customInstance = createSeederInstance({ expect: customExpect })
void customInstance.defineSeeder({
  name: 'custom',
  run: ({ expect: exp }) => {
    assertType<Equal<typeof exp, typeof customExpect>>()
    return exp('a').toCustomMatch()
  },
})

async function verify() {
  const maybeOnly: ('user' | 'post')[] | undefined = undefined
  const run = await runSeeders([user, post], { only: maybeOnly, verbose: false })
  if (run.success) {
    assertType<Equal<typeof run.outputs.post, { author: 'ok' } | undefined>>()
  }
  const full = await runSeeders([user, post])
  if (full.success) {
    assertType<Equal<typeof full.outputs.post, { author: 'ok' }>>()
  }
  const active: boolean = isSeedingActive()
  void active
}
void verify
`,
			)

			const configs = [
				[
					'NodeNext (no @types/bun)',
					[
						'--noEmit',
						'--strict',
						'--skipLibCheck',
						'--module',
						'NodeNext',
						'--moduleResolution',
						'NodeNext',
						'--target',
						'ESNext',
					],
				],
				[
					'bundler + exactOptionalPropertyTypes (no @types/bun)',
					[
						'--noEmit',
						'--strict',
						'--exactOptionalPropertyTypes',
						'--skipLibCheck',
						'--module',
						'ESNext',
						'--moduleResolution',
						'bundler',
						'--target',
						'ESNext',
					],
				],
			]
			for (const [label, args] of configs) {
				execFileSync(tscBin, [...args, typeCheckFile], {
					cwd: temporary,
					stdio: 'inherit',
					timeout: 30_000,
				})
				console.log(`Verified TypeScript declarations (${label})`)
			}

			// Also verify compatibility when @types/bun is installed alongside plantr
			const bunTypesDir = join(root, 'node_modules', '@types', 'bun')
			if (existsSync(bunTypesDir)) {
				symlinkSync(bunTypesDir, join(consumerTypesDir, 'bun'))
				const bunTypesPkg = join(root, 'node_modules', 'bun-types')
				if (existsSync(bunTypesPkg)) {
					symlinkSync(bunTypesPkg, join(temporary, 'node_modules', 'bun-types'))
				}
				const bunTypeCheckFile = join(temporary, 'consumer-bun-types.ts')
				writeFileSync(
					bunTypeCheckFile,
					`import { expect as bunExpect } from 'bun:test'
import { createSeederInstance, type ExpectFn } from 'plantr'

const _portable: ExpectFn = bunExpect
void _portable

const inst = createSeederInstance({ expect: bunExpect })
void inst.defineSeeder({
  name: 'bunCheck',
  run: ({ expect }) => {
    expect('ok').toBe('ok')
  },
})
`,
				)
				execFileSync(
					tscBin,
					[
						'--noEmit',
						'--strict',
						'--skipLibCheck',
						'--module',
						'NodeNext',
						'--moduleResolution',
						'NodeNext',
						'--target',
						'ESNext',
						bunTypeCheckFile,
					],
					{
						cwd: temporary,
						stdio: 'inherit',
						timeout: 30_000,
					},
				)
				console.log('Verified TypeScript declarations (NodeNext with @types/bun)')
			}
		}
	}
	if (pkg.name === 'expo-release') {
		execFileSync('bun', ['node_modules/expo-release/dist/cli.js', '--help'], {
			cwd: temporary,
			stdio: 'pipe',
			timeout: 10_000,
		})
	}
	copyFileSync(join(temporary, packed.filename), join(artifacts, 'package.tgz'))
	writeFileSync(
		join(artifacts, 'package.json'),
		`${JSON.stringify({ name: pkg.name, version: pkg.version })}\n`,
	)
	console.log(
		`Verified ${pkg.name}@${pkg.version}: ${files.size} files, ${specifiers.length} imports`,
	)
} finally {
	rmSync(temporary, { recursive: true, force: true })
}
