# Changelog

## [2.0.0](https://github.com/HansKristoffer/plantr/compare/v1.0.1...v2.0.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* runSeedersCli exits 1 on unknown flags, and positional arguments now select seeders (an unknown name exits 1). runSeeders throws DuplicateSeederError, MissingDependencyError, CircularDependencyError, UnknownSeederError or SeedTargetError instead of returning { results: [], success: false }. onBeforeAll now runs before the context factory, and onAfterAll also runs when the context factory throws. The runSeedersCore config hook setSeederName is now beforeSeeder.

### Features

* safer seeding runs, selectable seeders and a versioned step cache ([#3](https://github.com/HansKristoffer/plantr/issues/3)) ([f9e5d20](https://github.com/HansKristoffer/plantr/commit/f9e5d20234e3a9eb290ab45c421cacb31064330a))
