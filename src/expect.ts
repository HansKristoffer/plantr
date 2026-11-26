import assert, { AssertionError } from 'node:assert/strict'
import { createRequire } from 'node:module'
import { inspectValue } from './formatting.js'

/** Constructor type accepted by `toThrow(...)` */
// biome-ignore lint/suspicious/noExplicitAny: matches Error constructors with arbitrary parameters
export type ErrorConstructor = abstract new (...args: any[]) => unknown

/** Any callable assertion function accepted by `createSeederInstance({ expect })` */
// biome-ignore lint/complexity/noBannedTypes: using Function preserves generic inference for callable expect implementations (bun:test, vitest, jest, custom)
export type AnyExpectFn = Function

/**
 * Portable assertion matchers supported across Bun (`bun:test`) and Node.js (built-in fallback).
 * Compatible with `bun:test`, Vitest, and Jest `expect` implementations.
 */
export interface ExpectMatchers<T = unknown> {
	readonly not: ExpectMatchers<unknown>
	toBe<E = T>(expected: E): void
	toEqual<E = T>(expected: E): void
	toStrictEqual<E = T>(expected: E): void
	toBeDefined(): void
	toBeUndefined(): void
	toBeNull(): void
	toBeTruthy(): void
	toBeFalsy(): void
	toContain(expected: unknown): void
	toHaveLength(length: number): void
	toMatch(expected: string | RegExp): void
	toBeGreaterThan(expected: number | bigint): void
	toBeGreaterThanOrEqual(expected: number | bigint): void
	toBeLessThan(expected: number | bigint): void
	toBeLessThanOrEqual(expected: number | bigint): void
	toThrow(expected?: string | RegExp | Error | ErrorConstructor): void
}

/** Portable `expect` function signature available in `BaseSeederContext` */
export type ExpectFn = <T = unknown>(actual: T, message?: string) => ExpectMatchers<T>

function isPlainObject(value: object): value is Record<string | symbol, unknown> {
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/**
 * Normalize values for `toEqual` semantics:
 * - Strip `undefined`-valued properties on plain objects (`{ a: 1, b: undefined }` equals `{ a: 1 }`)
 * - Treat sparse array holes as `undefined` (`[, 1]` equals `[undefined, 1]`)
 * - Preserve cycles, `Date`, `RegExp`, `Map`, `Set`, typed arrays, and class instances
 */
function normalizeForEqual(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
	if (value === null || typeof value !== 'object') return value
	if (seen.has(value)) return seen.get(value)

	if (Array.isArray(value)) {
		const normalized: unknown[] = new Array(value.length)
		seen.set(value, normalized)
		for (let i = 0; i < value.length; i++) {
			normalized[i] = normalizeForEqual(value[i], seen)
		}
		return normalized
	}

	if (isPlainObject(value)) {
		const normalized: Record<string | symbol, unknown> =
			Object.getPrototypeOf(value) === null ? Object.create(null) : {}
		seen.set(value, normalized)
		for (const key of Reflect.ownKeys(value)) {
			const desc = Object.getOwnPropertyDescriptor(value, key)
			if (!desc?.enumerable) continue
			const entryValue = value[key]
			if (entryValue !== undefined) {
				normalized[key] = normalizeForEqual(entryValue, seen)
			}
		}
		return normalized
	}

	return value
}

function sameValueZero(a: unknown, b: unknown): boolean {
	return a === b || (Number.isNaN(a) && Number.isNaN(b))
}

function containsValue(actual: unknown, expected: unknown): boolean {
	if (typeof actual === 'string') {
		return typeof expected === 'string' && actual.includes(expected)
	}
	if (Array.isArray(actual)) {
		return actual.includes(expected)
	}
	if (actual instanceof Set) {
		return actual.has(expected)
	}
	if (
		actual !== null &&
		actual !== undefined &&
		typeof (actual as Iterable<unknown>)[Symbol.iterator] === 'function'
	) {
		for (const item of actual as Iterable<unknown>) {
			if (sameValueZero(item, expected)) return true
		}
	}
	return false
}

function matchesThrown(
	thrown: unknown,
	expected: string | RegExp | Error | ErrorConstructor,
): boolean {
	if (typeof expected === 'string') {
		const errorMessage = thrown instanceof Error ? thrown.message : String(thrown)
		return errorMessage.includes(expected)
	}
	if (expected instanceof RegExp) {
		const errorMessage = thrown instanceof Error ? thrown.message : String(thrown)
		const re =
			expected.global || expected.sticky ? new RegExp(expected.source, expected.flags) : expected
		return re.test(errorMessage)
	}
	if (expected instanceof Error) {
		if (!(thrown instanceof Error)) return false
		if (expected.constructor !== Error && !(thrown instanceof expected.constructor)) return false
		return thrown.message === expected.message
	}
	if (typeof expected === 'function') {
		return thrown instanceof expected
	}
	return false
}

function failAssertion(
	defaultMessage: string,
	actual: unknown,
	expected: unknown,
	operator: string,
	customMessage?: string,
): never {
	throw new AssertionError({
		message: customMessage ?? defaultMessage,
		actual,
		expected,
		operator,
	})
}

function createMatchers<T>(
	actual: T,
	message: string | undefined,
	negated: boolean,
): ExpectMatchers<T> {
	const checkComparison = (
		expected: number | bigint,
		operator: '>' | '>=' | '<' | '<=',
		label: string,
		compare: (a: number | bigint, b: number | bigint) => boolean,
	) => {
		if (typeof actual !== 'number' && typeof actual !== 'bigint') {
			failAssertion(
				`Expected a number or bigint, received ${typeof actual} (${inspectValue(actual)})`,
				actual,
				expected,
				operator,
				message,
			)
		}
		const passed = compare(actual, expected)
		if (negated ? passed : !passed) {
			failAssertion(
				`Expected ${inspectValue(actual)} ${negated ? 'not ' : ''}${label} ${inspectValue(expected)}`,
				actual,
				expected,
				negated ? `not ${operator}` : operator,
				message,
			)
		}
	}

	return {
		get not(): ExpectMatchers<unknown> {
			return createMatchers(actual as unknown, message, !negated)
		},

		toBe<E = T>(expected: E): void {
			if (negated) {
				assert.notStrictEqual(actual, expected, message)
			} else {
				assert.strictEqual(actual, expected, message)
			}
		},

		toEqual<E = T>(expected: E): void {
			const normActual = normalizeForEqual(actual)
			const normExpected = normalizeForEqual(expected)
			if (negated) {
				try {
					assert.notDeepStrictEqual(normActual, normExpected, message)
				} catch (err) {
					if (err instanceof AssertionError) {
						failAssertion(err.message, actual, expected, 'not toEqual', message)
					}
					throw err
				}
			} else {
				try {
					assert.deepStrictEqual(normActual, normExpected, message)
				} catch (err) {
					if (err instanceof AssertionError) {
						failAssertion(err.message, actual, expected, 'toEqual', message)
					}
					throw err
				}
			}
		},

		toStrictEqual<E = T>(expected: E): void {
			if (negated) {
				assert.notDeepStrictEqual(actual, expected, message)
			} else {
				assert.deepStrictEqual(actual, expected, message)
			}
		},

		toBeDefined(): void {
			const isDefined = actual !== undefined
			if (negated ? isDefined : !isDefined) {
				failAssertion(
					negated
						? `Expected ${inspectValue(actual)} to be undefined`
						: 'Expected value to be defined, received undefined',
					actual,
					undefined,
					negated ? 'not toBeDefined' : 'toBeDefined',
					message,
				)
			}
		},

		toBeUndefined(): void {
			if (negated) {
				assert.notStrictEqual(actual, undefined, message)
			} else {
				assert.strictEqual(actual, undefined, message)
			}
		},

		toBeNull(): void {
			if (negated) {
				assert.notStrictEqual(actual, null, message)
			} else {
				assert.strictEqual(actual, null, message)
			}
		},

		toBeTruthy(): void {
			const isTruthy = Boolean(actual)
			if (negated ? isTruthy : !isTruthy) {
				failAssertion(
					`Expected ${inspectValue(actual)} ${negated ? 'not ' : ''}to be truthy`,
					actual,
					!negated,
					negated ? 'not toBeTruthy' : 'toBeTruthy',
					message,
				)
			}
		},

		toBeFalsy(): void {
			const isFalsy = !actual
			if (negated ? isFalsy : !isFalsy) {
				failAssertion(
					`Expected ${inspectValue(actual)} ${negated ? 'not ' : ''}to be falsy`,
					actual,
					negated,
					negated ? 'not toBeFalsy' : 'toBeFalsy',
					message,
				)
			}
		},

		toContain(expected: unknown): void {
			const passed = containsValue(actual, expected)
			if (negated ? passed : !passed) {
				failAssertion(
					`Expected ${inspectValue(actual)} ${negated ? 'not ' : ''}to contain ${inspectValue(expected)}`,
					actual,
					expected,
					negated ? 'not toContain' : 'toContain',
					message,
				)
			}
		},

		toHaveLength(length: number): void {
			const actualLength =
				actual !== null && actual !== undefined
					? (actual as Record<string, unknown>).length
					: undefined
			if (typeof actualLength !== 'number') {
				failAssertion(
					`Expected ${inspectValue(actual)} to have a numeric length property`,
					actual,
					length,
					'toHaveLength',
					message,
				)
			}
			if (negated) {
				if (actualLength === length) {
					failAssertion(
						`Expected ${inspectValue(actual)} not to have length ${length}`,
						actualLength,
						length,
						'not toHaveLength',
						message,
					)
				}
			} else {
				assert.strictEqual(
					actualLength,
					length,
					message ??
						`Expected ${inspectValue(actual)} to have length ${length}, received ${actualLength}`,
				)
			}
		},

		toMatch(expected: string | RegExp): void {
			if (typeof actual !== 'string') {
				failAssertion(
					`Expected a string for toMatch, received ${typeof actual} (${inspectValue(actual)})`,
					actual,
					expected,
					'toMatch',
					message,
				)
			}
			const passed =
				expected instanceof RegExp
					? (expected.global || expected.sticky
							? new RegExp(expected.source, expected.flags)
							: expected
						).test(actual)
					: actual.includes(expected)
			if (negated ? passed : !passed) {
				failAssertion(
					`Expected ${inspectValue(actual)} ${negated ? 'not ' : ''}to match ${inspectValue(expected)}`,
					actual,
					expected,
					negated ? 'not toMatch' : 'toMatch',
					message,
				)
			}
		},

		toBeGreaterThan(expected: number | bigint): void {
			checkComparison(expected, '>', 'to be greater than', (a, b) => a > b)
		},

		toBeGreaterThanOrEqual(expected: number | bigint): void {
			checkComparison(expected, '>=', 'to be greater than or equal to', (a, b) => a >= b)
		},

		toBeLessThan(expected: number | bigint): void {
			checkComparison(expected, '<', 'to be less than', (a, b) => a < b)
		},

		toBeLessThanOrEqual(expected: number | bigint): void {
			checkComparison(expected, '<=', 'to be less than or equal to', (a, b) => a <= b)
		},

		toThrow(expected?: string | RegExp | Error | ErrorConstructor): void {
			if (typeof actual !== 'function') {
				failAssertion(
					`Expected a function for toThrow, received ${typeof actual} (${inspectValue(actual)})`,
					actual,
					expected,
					'toThrow',
					message,
				)
			}
			let threw = false
			let thrown: unknown
			try {
				;(actual as () => unknown)()
			} catch (err) {
				threw = true
				thrown = err
			}

			if (!threw) {
				if (!negated) {
					failAssertion(
						expected === undefined
							? 'Expected function to throw'
							: `Expected function to throw ${inspectValue(expected)}, but it did not throw`,
						undefined,
						expected,
						'toThrow',
						message,
					)
				}
				return
			}

			if (expected === undefined) {
				if (negated) {
					failAssertion(
						`Expected function not to throw, but it threw ${inspectValue(thrown)}`,
						thrown,
						undefined,
						'not toThrow',
						message,
					)
				}
				return
			}

			const matched = matchesThrown(thrown, expected)
			if (negated ? matched : !matched) {
				failAssertion(
					negated
						? `Expected function not to throw matching ${inspectValue(expected)}, but it threw ${inspectValue(thrown)}`
						: `Expected function to throw matching ${inspectValue(expected)}, but it threw ${inspectValue(thrown)}`,
					thrown,
					expected,
					negated ? 'not toThrow' : 'toThrow',
					message,
				)
			}
		},
	}
}

/**
 * Create a zero-dependency `expect` implementation backed by `node:assert/strict`.
 * Used automatically on Node.js when no custom `expect` is passed to `createSeederInstance`.
 */
export function createNodeExpect(): ExpectFn {
	return <T = unknown>(actual: T, message?: string): ExpectMatchers<T> =>
		createMatchers(actual, message, false)
}

let cachedDefaultExpect: ExpectFn | undefined

function loadBunExpect(): ExpectFn | undefined {
	if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') return undefined
	try {
		const req = createRequire(import.meta.url)
		// Dynamic specifier prevents bundlers and Node static analysis from resolving 'bun:test'
		const specifier = ['bun', 'test'].join(':')
		const mod = req(specifier) as { expect?: ExpectFn }
		if (typeof mod.expect === 'function') return mod.expect
	} catch {
		// Fall back to the Node implementation if bun:test cannot be loaded
	}
	return undefined
}

/**
 * Synchronously resolve the default `expect` function for the active runtime:
 * `bun:test`'s `expect` on Bun, or the built-in `node:assert/strict` implementation on Node.js.
 */
export function getDefaultExpect(): ExpectFn {
	if (!cachedDefaultExpect) {
		cachedDefaultExpect = loadBunExpect() ?? createNodeExpect()
	}
	return cachedDefaultExpect
}

/**
 * Runtime-safe `expect` export: lazily delegates to `bun:test`'s `expect` on Bun
 * and the built-in `node:assert/strict` fallback on Node.js.
 */
const expectTarget = (() => {
	throw new Error('unreachable')
}) as unknown as ExpectFn

export const expect: ExpectFn = new Proxy(expectTarget, {
	apply(_target, thisArg, args) {
		return Reflect.apply(getDefaultExpect(), thisArg, args)
	},
	get(_target, prop) {
		const impl = getDefaultExpect()
		const value = Reflect.get(impl, prop, impl)
		return typeof value === 'function' ? value.bind(impl) : value
	},
	has(_target, prop) {
		return Reflect.has(getDefaultExpect(), prop)
	},
	ownKeys() {
		return Reflect.ownKeys(getDefaultExpect())
	},
	getOwnPropertyDescriptor(_target, prop) {
		const desc = Reflect.getOwnPropertyDescriptor(getDefaultExpect(), prop)
		return desc ? { ...desc, configurable: true } : undefined
	},
	getPrototypeOf() {
		return Reflect.getPrototypeOf(getDefaultExpect())
	},
})
