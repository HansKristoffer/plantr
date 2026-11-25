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
	const runtime = ['plantr', 'expo-release'].includes(pkg.name) ? 'bun' : process.execPath
	execFileSync(runtime, ['--input-type=module', '-e', code], {
		cwd: temporary,
		stdio: 'inherit',
		timeout: 30_000,
	})
	if (pkg.name === 'plantr') {
		execFileSync(
			'bun',
			[
				'-e',
				`import { createSeederInstance, faker } from 'plantr'; const { defineSeeder, runSeeders } = createSeederInstance({ concurrency: 2, fakerSeed: 1 }); const seed = defineSeeder({ name: 'smoke', run: async ({ expect, faker: f }) => { expect(f.person.fullName().length).toBeGreaterThan(0); expect(faker.person.fullName().length).toBeGreaterThan(0); return 1; } }); const result = await runSeeders([seed], { verbose: false, printResults: false }); if (!result.success || result.outputs.smoke !== 1) process.exit(1);`,
			],
			{ cwd: temporary, stdio: 'inherit', timeout: 30_000 },
		)

		// Verify emitted .d.ts files resolve cleanly under NodeNext, bundler, and exactOptionalPropertyTypes
		// without silently degrading to `any`.
		const tscBin = join(root, 'node_modules', '.bin', 'tsc')
		const bunTypesDir = join(root, 'node_modules', '@types', 'bun')
		if (existsSync(tscBin) && existsSync(bunTypesDir)) {
			const consumerTypesDir = join(temporary, 'node_modules', '@types')
			mkdirSync(consumerTypesDir, { recursive: true })
			symlinkSync(bunTypesDir, join(consumerTypesDir, 'bun'))
			const bunTypesPkg = join(root, 'node_modules', 'bun-types')
			if (existsSync(bunTypesPkg)) {
				symlinkSync(bunTypesPkg, join(temporary, 'node_modules', 'bun-types'))
			}
			const nodeTypesDir = join(root, 'node_modules', '@types', 'node')
			if (existsSync(nodeTypesDir)) {
				symlinkSync(nodeTypesDir, join(consumerTypesDir, 'node'))
			}

			const typeCheckFile = join(temporary, 'consumer-types.ts')
			writeFileSync(
				typeCheckFile,
				`import { createSeederInstance, type SeederCache } from 'plantr'
import { isSeedingActive } from 'plantr/state'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const assertType = <_T extends true>() => {}

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
  run: ({ db }) => ({ id: db }),
})
const post = defineSeeder({
  name: 'post',
  dependsOn: [user],
  run: (_ctx, deps) => ({ author: deps.user.id }),
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
					'NodeNext',
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
					'bundler + exactOptionalPropertyTypes',
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
