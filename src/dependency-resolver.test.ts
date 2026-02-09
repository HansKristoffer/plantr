import { describe, expect, it } from 'bun:test'
import {
	CircularDependencyError,
	MissingDependencyError,
	resolveDependencyOrder,
} from './dependency-resolver'
import type { SeederAny } from './types'

// Helper to create a mock seeder
function createMockSeeder(name: string, dependsOn: string[] = []): SeederAny {
	return {
		name,
		dependsOn,
		run: async () => ({}),
	}
}

describe('resolveDependencyOrder', () => {
	it('should return empty array for no seeders', () => {
		const result = resolveDependencyOrder([])
		expect(result).toEqual([])
	})

	it('should return single seeder in array', () => {
		const seeder = createMockSeeder('seederA')
		const result = resolveDependencyOrder([seeder])
		expect(result).toEqual(['seederA'])
	})

	it('should handle seeders with no dependencies', () => {
		const seeders = [
			createMockSeeder('seederA'),
			createMockSeeder('seederB'),
			createMockSeeder('seederC'),
		]
		const result = resolveDependencyOrder(seeders)
		expect(result).toHaveLength(3)
		expect(result).toContain('seederA')
		expect(result).toContain('seederB')
		expect(result).toContain('seederC')
	})

	it('should order seeders by dependencies', () => {
		const seeders = [
			createMockSeeder('seederC', ['seederB']),
			createMockSeeder('seederB', ['seederA']),
			createMockSeeder('seederA'),
		]
		const result = resolveDependencyOrder(seeders)
		expect(result).toEqual(['seederA', 'seederB', 'seederC'])
	})

	it('should handle multiple dependencies', () => {
		const seeders = [
			createMockSeeder('seederD', ['seederB', 'seederC']),
			createMockSeeder('seederB', ['seederA']),
			createMockSeeder('seederC', ['seederA']),
			createMockSeeder('seederA'),
		]
		const result = resolveDependencyOrder(seeders)

		// seederA must come first
		expect(result.indexOf('seederA')).toBe(0)
		// seederD must come last
		expect(result.indexOf('seederD')).toBe(3)
		// seederB and seederC must come before seederD
		expect(result.indexOf('seederB')).toBeLessThan(result.indexOf('seederD'))
		expect(result.indexOf('seederC')).toBeLessThan(result.indexOf('seederD'))
	})

	it('should throw MissingDependencyError for non-existent dependency', () => {
		const seeders = [
			createMockSeeder('seederA', ['seederB']), // seederB doesn't exist
		]
		expect(() => resolveDependencyOrder(seeders)).toThrow(MissingDependencyError)
		expect(() => resolveDependencyOrder(seeders)).toThrow(
			'Seeder "seederA" depends on "seederB" which does not exist',
		)
	})

	it('should throw CircularDependencyError for direct circular dependency', () => {
		const seeders = [
			createMockSeeder('seederA', ['seederB']),
			createMockSeeder('seederB', ['seederA']),
		]
		expect(() => resolveDependencyOrder(seeders)).toThrow(CircularDependencyError)
	})

	it('should throw CircularDependencyError for indirect circular dependency', () => {
		const seeders = [
			createMockSeeder('seederA', ['seederC']),
			createMockSeeder('seederB', ['seederA']),
			createMockSeeder('seederC', ['seederB']),
		]
		expect(() => resolveDependencyOrder(seeders)).toThrow(CircularDependencyError)
	})

	it('should throw CircularDependencyError for self-dependency', () => {
		const seeders = [createMockSeeder('seederA', ['seederA'])]
		expect(() => resolveDependencyOrder(seeders)).toThrow(CircularDependencyError)
	})

	it('should handle complex dependency graph', () => {
		// Graph:
		// A (no deps)
		// B -> A
		// C -> A
		// D -> B, C
		// E -> D
		// F (no deps)
		const seeders = [
			createMockSeeder('seederF'),
			createMockSeeder('seederE', ['seederD']),
			createMockSeeder('seederD', ['seederB', 'seederC']),
			createMockSeeder('seederC', ['seederA']),
			createMockSeeder('seederB', ['seederA']),
			createMockSeeder('seederA'),
		]
		const result = resolveDependencyOrder(seeders)

		// Verify constraints
		expect(result.indexOf('seederA')).toBeLessThan(result.indexOf('seederB'))
		expect(result.indexOf('seederA')).toBeLessThan(result.indexOf('seederC'))
		expect(result.indexOf('seederB')).toBeLessThan(result.indexOf('seederD'))
		expect(result.indexOf('seederC')).toBeLessThan(result.indexOf('seederD'))
		expect(result.indexOf('seederD')).toBeLessThan(result.indexOf('seederE'))
		// seederF can be anywhere since it has no deps and nothing depends on it
	})
})
