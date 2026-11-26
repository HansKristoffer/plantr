# Changelog

## [2.3.0](https://github.com/HansKristoffer/plantr/compare/v2.2.0...v2.3.0) (2026-11-26)


### Features

* setup/teardown resources, cache factory, onFresh, per-step faker, usage errors and mapWithLimit ([#10](https://github.com/HansKristoffer/plantr/issues/10)) ([039ae4d](https://github.com/HansKristoffer/plantr/commit/039ae4d7e0e61b4554f942de143299a4d2f22246))

## [2.2.0](https://github.com/HansKristoffer/plantr/compare/v2.1.0...v2.2.0) (2026-11-26)


### Features

* support Node.js &gt;= 22 runtime, custom expect, and emulator target guard ([#8](https://github.com/HansKristoffer/plantr/issues/8)) ([a8c0c83](https://github.com/HansKristoffer/plantr/commit/a8c0c832a1ca783f07a32171a068ac7280ac5d2f))

## [2.1.0](https://github.com/HansKristoffer/plantr/compare/v2.0.0...v2.1.0) (2026-11-25)


### Features

* parallel DAG seeding, lazy faker loading, batch cache I/O, and end-to-end TypeScript ([#5](https://github.com/HansKristoffer/plantr/issues/5)) ([c06dd30](https://github.com/HansKristoffer/plantr/commit/c06dd30b76a95871015cec609c73e89766476e7f))

## [2.0.0](https://github.com/HansKristoffer/plantr/compare/v1.0.1...v2.0.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* runSeedersCli exits 1 on unknown flags, and positional arguments now select seeders (an unknown name exits 1). runSeeders throws DuplicateSeederError, MissingDependencyError, CircularDependencyError, UnknownSeederError or SeedTargetError instead of returning { results: [], success: false }. onBeforeAll now runs before the context factory, and onAfterAll also runs when the context factory throws. The runSeedersCore config hook setSeederName is now beforeSeeder.

### Features

* safer seeding runs, selectable seeders and a versioned step cache ([#3](https://github.com/HansKristoffer/plantr/issues/3)) ([f9e5d20](https://github.com/HansKristoffer/plantr/commit/f9e5d20234e3a9eb290ab45c421cacb31064330a))
