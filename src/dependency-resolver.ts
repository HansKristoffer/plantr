import type { SeederAny } from './types'

/**
 * Error thrown when circular dependencies are detected in seeders
 */
export class CircularDependencyError extends Error {
	constructor(cycle: string[]) {
		super(`Circular dependency detected in seeders: ${cycle.join(' -> ')} -> ${cycle[0]}`)
		this.name = 'CircularDependencyError'
	}
}

/**
 * Error thrown when a seeder depends on a non-existent seeder
 */
export class MissingDependencyError extends Error {
	constructor(seeder: string, missingDep: string) {
		super(`Seeder "${seeder}" depends on "${missingDep}" which does not exist`)
		this.name = 'MissingDependencyError'
	}
}

/**
 * Error thrown when two seeders share a name
 */
export class DuplicateSeederError extends Error {
	constructor(name: string) {
		super(`Two seeders are named "${name}"; seeder names must be unique`)
		this.name = 'DuplicateSeederError'
	}
}

/**
 * Error thrown when a seeder is selected by a name that is not registered
 */
export class UnknownSeederError extends Error {
	constructor(name: string, known: readonly string[]) {
		super(`Unknown seeder "${name}". Registered seeders: ${known.join(', ') || '(none)'}`)
		this.name = 'UnknownSeederError'
	}
}

/**
 * Resolves the execution order of seeders based on their dependencies
 * using Kahn's algorithm (topological sort)
 *
 * @param seeders - Array of seeders to sort
 * @param only - Optional names to select: returns them and everything they depend on
 * @returns Array of seeder names in execution order
 * @throws {DuplicateSeederError} If two seeders share a name
 * @throws {UnknownSeederError} If a name in `only` is not registered
 * @throws {CircularDependencyError} If circular dependencies are detected
 * @throws {MissingDependencyError} If a seeder depends on a non-existent seeder
 */
export function resolveDependencyOrder(
	seeders: readonly SeederAny[],
	only?: readonly string[],
): string[] {
	// Build a map of seeder names for quick lookup
	const seederMap = new Map<string, SeederAny>()
	for (const seeder of seeders) {
		if (seederMap.has(seeder.name)) throw new DuplicateSeederError(seeder.name)
		seederMap.set(seeder.name, seeder)
	}

	// Validate all dependencies exist
	for (const seeder of seeders) {
		for (const dep of seeder.dependsOn) {
			if (!seederMap.has(dep)) {
				throw new MissingDependencyError(seeder.name, dep)
			}
		}
	}

	// Build adjacency list and in-degree count
	const inDegree = new Map<string, number>()
	const dependents = new Map<string, string[]>()

	// Initialize
	for (const seeder of seeders) {
		inDegree.set(seeder.name, 0)
		dependents.set(seeder.name, [])
	}

	// Build the graph
	for (const seeder of seeders) {
		inDegree.set(seeder.name, seeder.dependsOn.length)
		for (const dep of seeder.dependsOn) {
			const deps = dependents.get(dep)
			if (deps) {
				deps.push(seeder.name)
			}
		}
	}

	// Find all seeders with no dependencies (in-degree 0)
	const queue: string[] = []
	for (const [name, degree] of inDegree) {
		if (degree === 0) {
			queue.push(name)
		}
	}

	// Process the queue
	const result: string[] = []
	while (queue.length > 0) {
		const current = queue.shift()!
		result.push(current)

		// Reduce in-degree for all dependents
		const deps = dependents.get(current) ?? []
		for (const dependent of deps) {
			const newDegree = (inDegree.get(dependent) ?? 0) - 1
			inDegree.set(dependent, newDegree)
			if (newDegree === 0) {
				queue.push(dependent)
			}
		}
	}

	// Check for circular dependencies
	if (result.length !== seeders.length) {
		// Find the cycle for a better error message
		const remaining = seeders.filter((s) => !result.includes(s.name))
		const cycle = findCycle(remaining, seederMap)
		throw new CircularDependencyError(cycle)
	}

	if (!only) return result

	// Keep the selected seeders and their transitive dependencies, in execution order
	const selected = new Set<string>()
	const visit = (name: string) => {
		if (selected.has(name)) return
		selected.add(name)
		for (const dep of seederMap.get(name)?.dependsOn ?? []) visit(dep)
	}
	for (const name of only) {
		if (!seederMap.has(name)) throw new UnknownSeederError(name, [...seederMap.keys()])
		visit(name)
	}
	return result.filter((name) => selected.has(name))
}

/**
 * Find a cycle in the remaining seeders for error reporting.
 * Returns the nodes that form the cycle.
 */
function findCycle(remaining: readonly SeederAny[], seederMap: Map<string, SeederAny>): string[] {
	const visited = new Set<string>()
	const path: string[] = []
	let cycleStart = -1

	function dfs(name: string): boolean {
		const existingIndex = path.indexOf(name)
		if (existingIndex !== -1) {
			// Found cycle - record where it starts
			cycleStart = existingIndex
			return true
		}
		if (visited.has(name)) {
			return false
		}

		visited.add(name)
		path.push(name)

		const seeder = seederMap.get(name)
		if (seeder) {
			for (const dep of seeder.dependsOn) {
				if (dfs(dep)) {
					return true
				}
			}
		}

		path.pop()
		return false
	}

	for (const seeder of remaining) {
		path.length = 0
		cycleStart = -1
		if (dfs(seeder.name)) {
			// Return only the cycle portion of the path
			return cycleStart >= 0 ? path.slice(cycleStart) : path
		}
	}

	// Fallback: just return the names of remaining seeders
	return remaining.map((s) => s.name)
}
