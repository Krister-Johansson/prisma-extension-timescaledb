# Security assurance case

This page explains why we believe prisma-extension-timescaledb is safe to use
against your database. It states the threat model, walks the trust boundaries,
and points at the controls behind each claim. Report anything that contradicts
it through [SECURITY.md](../SECURITY.md).

## What the package is, from a security point of view

prisma-extension-timescaledb runs in two places. At development time, a Prisma
generator reads the project's own `schema.prisma` and writes migration SQL and
a TypeScript registry into the project. At runtime, a Prisma Client Extension
builds SQL queries and runs them through the application's own Prisma client,
with whatever database permissions that client has. The package has no server
component, no accounts, no credentials, and no network activity of its own;
every byte it sends to the database goes through Prisma's driver.

## Threat model

The realistic threats are:

1. **SQL injection through the schema.** The generator turns `///` annotation
   text into migration SQL. A crafted annotation value (a table name, an
   interval, an aggregate spec) could try to smuggle SQL into the emitted
   migrations, which later run with the migration user's privileges.
2. **SQL injection at runtime.** `timeBucket` queries accept `where` values
   that typically come from application request data, which makes them
   attacker-influenced in a way the schema is not.
3. **Compromise of the package itself.** An attacker who could publish a
   tampered release would run code inside every application that installs it,
   next to a live database connection.
4. **Compromise through dependencies.** The same, one level down.
5. **Wrong SQL damaging user databases.** Migrations that are not replay-safe
   break `prisma migrate reset` and can leave databases half-migrated; that is
   an integrity threat even with no attacker.

## Argument, threat by threat

### 1. Annotations cannot smuggle SQL into migrations

- All quoting lives in one module, `src/core/sql.ts`. Identifiers are quoted
  with embedded double quotes doubled; string literals with single quotes
  doubled; `assertSafeIdent` rejects names outside
  `[A-Za-z_][A-Za-z0-9_]*` where quoting alone is not enough.
- The annotation parser rejects unknown annotations and malformed arguments
  loudly, naming the model and field, instead of passing text through.
  Intervals are parsed and validated in `core/interval.ts`, not spliced in as
  raw strings.
- Emitted migrations are deterministic (a pure path-to-content map with no
  timestamps), so unit tests snapshot the exact SQL and a review can read the
  diff of what would run.
- The schema is the developer's own file, so this boundary defends against
  mistakes and copy-pasted schemas more than against a dedicated attacker;
  the controls hold either way.

### 2. Runtime query values are parameters, never text

- `timeBucket` and the `where` translator build one parameterized query:
  values are always bound as `$`-parameters, and column names are resolved
  through the generated registry and identifier-checked before quoting. The
  query text that reaches `$queryRawUnsafe` contains placeholders, not
  values. The bucket size itself can come from caller data too; it is
  validated by `assertInterval` before the query is built, then bound as the
  first parameter.
- Relation filters become correlated `EXISTS` subqueries built from
  registered relation metadata; an unsupported operator or an unregistered
  relation throws instead of degrading into string concatenation.
- Management methods in the `$timescale` namespace quote identifiers through
  `core/sql.ts` and bind filter values as parameters. Interval options (for
  example a policy's `drop_after`) are the one exception: they are validated
  against the interval grammar, then rendered as escaped SQL literals, so
  invalid input throws before any SQL is built.

### 3. A published release is what the repository built

- Releases are published to npm from GitHub Actions through OIDC trusted
  publishing with provenance. There is no long-lived npm token to steal, and
  the published version carries a Sigstore attestation linking it to the
  repository, commit, and workflow run that built it. SECURITY.md documents
  how to verify this.
- `main` is protected: changes arrive by pull request, required CI (including
  the integration suite against a real TimescaleDB) must pass, and versioning
  is automated with release-please rather than done by hand on a laptop.
- The published package contains only `dist/`, the compiled output of the
  repository's TypeScript.

### 4. The dependency surface is one package deep

- There is exactly one runtime dependency, `@prisma/generator-helper`, needed
  to speak Prisma's generator protocol. `prisma` and `@prisma/client` are
  peer dependencies supplied by the application. Nothing from Prisma is
  bundled.
- Dependabot opens weekly grouped update PRs, and CodeQL, OpenSSF Scorecard,
  and Socket run against the repository. Updates land through the same
  reviewed-PR process as code. Remediation timelines are in
  [security-policies.md](./security-policies.md).

### 5. Migrations are replay-safe by construction and by proof

- The constraints that make migrations reset-safe (a standalone idempotent
  extension migration, `IF NOT EXISTS` on all DDL, no `::regclass` casts,
  `DROP MATERIALIZED VIEW` for continuous aggregates) are documented in
  CLAUDE.md and enforced in the emitters.
- The guarantee is tested, not asserted: an integration test runs a fresh
  TimescaleDB container through `migrate reset` and `migrate deploy` and
  checks that every hypertable and continuous aggregate comes back with zero
  manual steps.

## Secure development practices behind the claims

TypeScript `strict` mode and a vitest suite with enforced coverage thresholds
run on every pull request on Node 20 and 22, alongside type-level tests, the
Testcontainers integration suite, and an automated review. Changes get the
maintainer's review before merge. The full workflow is in
[CONTRIBUTING.md](../CONTRIBUTING.md) and [GOVERNANCE.md](../GOVERNANCE.md).

## Known limitations

- The extension runs with the database permissions of the application's
  Prisma client, and migrations run with the migration user's privileges. The
  package does not sandbox either; scope those database roles as you would
  for any migration tool.
- `$queryRawUnsafe` is used deliberately because the SQL text is assembled
  from quoted identifiers and parameter placeholders. The safety argument
  rests on the discipline that identifiers come only from the registry or
  pass `assertSafeIdent`, which is why all quoting is centralized and tested.
- The generator trusts `schema.prisma` to be the developer's own input.
  Generating from a hostile schema produces hostile migrations by definition;
  the defense is that migrations are plain SQL files the developer can read
  before applying.
