import { createRequire } from 'node:module'
import type { Faker } from '@faker-js/faker'

let loadedFaker: Faker | undefined

/**
 * Synchronously load the default English Faker instance on first access.
 * Defers the ~35ms locale initialization cost until a seeder actually uses `faker`.
 */
export function getDefaultFaker(): Faker {
	if (!loadedFaker) {
		const req = createRequire(import.meta.url)
		const mod = req('@faker-js/faker/locale/en') as { faker: Faker }
		loadedFaker = mod.faker
	}
	return loadedFaker
}

/**
 * Lazy proxy for the default English Faker instance.
 * Importing `plantr` does not pay the faker load cost until a property is accessed.
 */
export const lazyFaker: Faker = new Proxy({} as Faker, {
	get(_target, prop) {
		const instance = getDefaultFaker()
		const value = Reflect.get(instance, prop, instance)
		return typeof value === 'function' && prop !== 'constructor' ? value.bind(instance) : value
	},
	set(_target, prop, value) {
		const instance = getDefaultFaker()
		return Reflect.set(instance, prop, value, instance)
	},
	has(_target, prop) {
		return Reflect.has(getDefaultFaker(), prop)
	},
	ownKeys() {
		return Reflect.ownKeys(getDefaultFaker())
	},
	getOwnPropertyDescriptor(_target, prop) {
		const desc = Reflect.getOwnPropertyDescriptor(getDefaultFaker(), prop)
		return desc ? { ...desc, configurable: true } : undefined
	},
	getPrototypeOf() {
		return Reflect.getPrototypeOf(getDefaultFaker())
	},
})
