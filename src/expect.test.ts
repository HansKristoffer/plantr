import { expect as bunExpect, describe, it } from 'bun:test'
import { AssertionError } from 'node:assert/strict'
import { createNodeExpect, expect as defaultExpect, getDefaultExpect } from './expect.js'
import { inspectValue } from './formatting.js'

describe('expect (Node fallback & runtime resolution)', () => {
	const nodeExpect = createNodeExpect()

	describe('runtime resolution on Bun', () => {
		it('should resolve bun:test expect as default on Bun', () => {
			bunExpect(getDefaultExpect()).toBe(bunExpect)
			defaultExpect(1 + 1).toBe(2)
			defaultExpect({ a: 1 }).toEqual({ a: 1 })
			// Proxy forwards bun:test static properties like expect.any
			const anyString = (defaultExpect as unknown as typeof bunExpect).any(String)
			bunExpect({ name: 'Ada' }).toEqual({ name: anyString })
		})
	})

	describe('inspectValue', () => {
		it('should inspect values on Bun and fall back to node:util inspect when Bun is absent', () => {
			const err = new Error('boom', { cause: new Error('inner cause') })
			const bunOut = inspectValue(err, { colors: false })
			bunExpect(bunOut).toContain('boom')
			bunExpect(bunOut).toContain('inner cause')

			const g = globalThis as { Bun?: unknown }
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Bun')
			if (descriptor?.configurable) {
				const originalBun = g.Bun
				try {
					Object.defineProperty(globalThis, 'Bun', {
						value: undefined,
						configurable: true,
						writable: true,
					})
					const nodeOut = inspectValue(err, { colors: false })
					bunExpect(nodeOut).toContain('boom')
					bunExpect(nodeOut).toContain('inner cause')
				} finally {
					Object.defineProperty(globalThis, 'Bun', {
						...descriptor,
						value: originalBun,
					})
				}
			}
		})
	})

	describe('createNodeExpect matchers', () => {
		it('toBe / .not.toBe', () => {
			nodeExpect(42).toBe(42)
			nodeExpect(Number.NaN).toBe(Number.NaN)
			nodeExpect(42).not.toBe(43)
			nodeExpect(-0).not.toBe(+0)
			nodeExpect(42).not.not.toBe(42)

			bunExpect(() => nodeExpect(1).toBe(2)).toThrow(AssertionError)
			bunExpect(() => nodeExpect(1).not.toBe(1)).toThrow(AssertionError)
			bunExpect(() => nodeExpect(1, 'custom toBe message').toBe(2)).toThrow('custom toBe message')
		})

		it('toEqual / .not.toEqual', () => {
			nodeExpect({ a: 1, b: [2, 3] }).toEqual({ a: 1, b: [2, 3] })
			// Plain object undefined properties are ignored by toEqual
			nodeExpect({ a: 1, b: undefined }).toEqual({ a: 1 })
			nodeExpect({ a: 1 }).toEqual({ a: 1, b: undefined })
			// Sparse array holes equal undefined in toEqual
			const sparse = new Array<number | undefined>(3)
			sparse[0] = 1
			sparse[2] = 3
			nodeExpect(sparse).toEqual([1, undefined, 3])
			// Built-ins
			nodeExpect(new Date('2025-01-01T00:00:00Z')).toEqual(new Date('2025-01-01T00:00:00Z'))
			nodeExpect(new Set([1, 2])).toEqual(new Set([1, 2]))
			nodeExpect(new Map([['a', 1]])).toEqual(new Map([['a', 1]]))
			// Circular objects do not overflow
			const a: Record<string, unknown> = { x: 1 }
			a.self = a
			const b: Record<string, unknown> = { x: 1 }
			b.self = b
			nodeExpect(a).toEqual(b)

			nodeExpect({ a: 1 }).not.toEqual({ a: 2 })
			bunExpect(() => nodeExpect({ a: 1 }).toEqual({ a: 2 })).toThrow(AssertionError)
			bunExpect(() => nodeExpect({ a: 1, b: undefined }).not.toEqual({ a: 1 })).toThrow(
				AssertionError,
			)
		})

		it('toStrictEqual / .not.toStrictEqual', () => {
			nodeExpect({ a: 1, b: [2] }).toStrictEqual({ a: 1, b: [2] })
			nodeExpect({ a: 1, b: undefined }).not.toStrictEqual({ a: 1 })
			const sparse = new Array<number | undefined>(3)
			sparse[0] = 1
			sparse[2] = 3
			nodeExpect(sparse).not.toStrictEqual([1, undefined, 3])

			bunExpect(() => nodeExpect({ a: 1, b: undefined }).toStrictEqual({ a: 1 })).toThrow(
				AssertionError,
			)
			bunExpect(() => nodeExpect({ a: 1 }).not.toStrictEqual({ a: 1 })).toThrow(AssertionError)
		})

		it('toBeDefined / toBeUndefined / toBeNull', () => {
			nodeExpect(0).toBeDefined()
			nodeExpect(null).toBeDefined()
			nodeExpect(undefined).not.toBeDefined()
			bunExpect(() => nodeExpect(undefined).toBeDefined()).toThrow(AssertionError)
			bunExpect(() => nodeExpect('x').not.toBeDefined()).toThrow(AssertionError)

			nodeExpect(undefined).toBeUndefined()
			nodeExpect(null).not.toBeUndefined()
			bunExpect(() => nodeExpect(null).toBeUndefined()).toThrow(AssertionError)
			bunExpect(() => nodeExpect(undefined).not.toBeUndefined()).toThrow(AssertionError)

			nodeExpect(null).toBeNull()
			nodeExpect(undefined).not.toBeNull()
			bunExpect(() => nodeExpect(undefined).toBeNull()).toThrow(AssertionError)
			bunExpect(() => nodeExpect(null).not.toBeNull()).toThrow(AssertionError)
		})

		it('toBeTruthy / toBeFalsy', () => {
			nodeExpect(1).toBeTruthy()
			nodeExpect('ok').toBeTruthy()
			nodeExpect(0).not.toBeTruthy()
			nodeExpect('').not.toBeTruthy()
			bunExpect(() => nodeExpect(0).toBeTruthy()).toThrow(AssertionError)
			bunExpect(() => nodeExpect(1).not.toBeTruthy()).toThrow(AssertionError)

			nodeExpect(0).toBeFalsy()
			nodeExpect('').toBeFalsy()
			nodeExpect(null).toBeFalsy()
			nodeExpect(undefined).toBeFalsy()
			nodeExpect(false).toBeFalsy()
			nodeExpect(1).not.toBeFalsy()
			bunExpect(() => nodeExpect('non-empty').toBeFalsy()).toThrow(AssertionError)
			bunExpect(() => nodeExpect(false).not.toBeFalsy()).toThrow(AssertionError)
		})

		it('toContain / .not.toContain', () => {
			nodeExpect('hello world').toContain('world')
			nodeExpect('hello world').not.toContain('mars')
			nodeExpect([1, 2, 3]).toContain(2)
			nodeExpect([Number.NaN]).toContain(Number.NaN)
			nodeExpect([1, 2, 3]).not.toContain(4)
			nodeExpect(new Set(['a', 'b'])).toContain('b')
			nodeExpect(new Set(['a', 'b'])).not.toContain('c')
			nodeExpect(new Uint8Array([10, 20])).toContain(20)
			nodeExpect(null).not.toContain('a')

			bunExpect(() => nodeExpect('hello').toContain('xyz')).toThrow(AssertionError)
			bunExpect(() => nodeExpect([1, 2]).toContain(3)).toThrow(AssertionError)
			bunExpect(() => nodeExpect([1, 2]).not.toContain(2)).toThrow(AssertionError)
		})

		it('toHaveLength / .not.toHaveLength', () => {
			nodeExpect([1, 2, 3]).toHaveLength(3)
			nodeExpect('abc').toHaveLength(3)
			nodeExpect({ length: 5 }).toHaveLength(5)
			nodeExpect([1, 2]).not.toHaveLength(3)

			bunExpect(() => nodeExpect([1, 2]).toHaveLength(3)).toThrow(AssertionError)
			bunExpect(() => nodeExpect([1, 2]).not.toHaveLength(2)).toThrow(AssertionError)
			bunExpect(() => nodeExpect({}).toHaveLength(0)).toThrow(AssertionError)
		})

		it('toMatch / .not.toMatch', () => {
			nodeExpect('hello world').toMatch('world')
			nodeExpect('hello world').toMatch(/^hello/)
			nodeExpect('hello world').not.toMatch(/^world/)
			nodeExpect('hello world').not.toMatch('mars')

			// Stateful /g regex does not corrupt consecutive assertions
			const globalRe = /foo/g
			nodeExpect('foo').toMatch(globalRe)
			nodeExpect('foo').toMatch(globalRe)

			bunExpect(() => nodeExpect('hello').toMatch(/xyz/)).toThrow(AssertionError)
			bunExpect(() => nodeExpect('hello').not.toMatch(/ell/)).toThrow(AssertionError)
			bunExpect(() => nodeExpect(123 as unknown as string).toMatch('123')).toThrow(AssertionError)
		})

		it('numeric and bigint comparisons', () => {
			nodeExpect(5).toBeGreaterThan(3)
			nodeExpect(5).not.toBeGreaterThan(5)
			nodeExpect(5n).toBeGreaterThan(3n)
			nodeExpect(5n).toBeGreaterThan(3)

			nodeExpect(5).toBeGreaterThanOrEqual(5)
			nodeExpect(5).toBeGreaterThanOrEqual(4)
			nodeExpect(5).not.toBeGreaterThanOrEqual(6)

			nodeExpect(3).toBeLessThan(5)
			nodeExpect(3).not.toBeLessThan(3)
			nodeExpect(3n).toBeLessThan(5n)

			nodeExpect(3).toBeLessThanOrEqual(3)
			nodeExpect(3).toBeLessThanOrEqual(4)
			nodeExpect(3).not.toBeLessThanOrEqual(2)

			bunExpect(() => nodeExpect(3).toBeGreaterThan(5)).toThrow(AssertionError)
			bunExpect(() => nodeExpect(3).toBeGreaterThanOrEqual(5)).toThrow(AssertionError)
			bunExpect(() => nodeExpect(5).toBeLessThan(3)).toThrow(AssertionError)
			bunExpect(() => nodeExpect(5).toBeLessThanOrEqual(3)).toThrow(AssertionError)
			bunExpect(() => nodeExpect('5' as unknown as number).toBeGreaterThan(3)).toThrow(
				AssertionError,
			)
		})

		it('toThrow / .not.toThrow', () => {
			class CustomError extends Error {}

			nodeExpect(() => {
				throw new CustomError('something broke')
			}).toThrow()
			nodeExpect(() => {
				throw new CustomError('something broke')
			}).toThrow('something')
			nodeExpect(() => {
				throw new CustomError('something broke')
			}).toThrow(/broke$/)
			nodeExpect(() => {
				throw new CustomError('something broke')
			}).toThrow(CustomError)
			nodeExpect(() => {
				throw new CustomError('something broke')
			}).toThrow(new CustomError('something broke'))
			nodeExpect(() => {
				throw 'plain string error'
			}).toThrow('plain string')
			nodeExpect(() => {
				throw null
			}).toThrow()

			nodeExpect(() => 'ok').not.toThrow()
			nodeExpect(() => 'ok').not.toThrow('anything')
			nodeExpect(() => {
				throw new TypeError('wrong type')
			}).not.toThrow(RangeError)
			nodeExpect(() => {
				throw new Error('alpha')
			}).not.toThrow('beta')

			bunExpect(() => nodeExpect(() => 'ok').toThrow()).toThrow(AssertionError)
			bunExpect(() =>
				nodeExpect(() => {
					throw new Error('alpha')
				}).toThrow('beta'),
			).toThrow(AssertionError)
			bunExpect(() =>
				nodeExpect(() => {
					throw new TypeError('alpha')
				}).toThrow(RangeError),
			).toThrow(AssertionError)
			bunExpect(() =>
				nodeExpect(() => {
					throw new Error('alpha')
				}).not.toThrow(),
			).toThrow(AssertionError)
			bunExpect(() =>
				nodeExpect(() => {
					throw new Error('alpha')
				}).not.toThrow('alpha'),
			).toThrow(AssertionError)
			bunExpect(() => nodeExpect('not-a-fn' as unknown as () => void).toThrow()).toThrow(
				AssertionError,
			)
		})
	})
})
