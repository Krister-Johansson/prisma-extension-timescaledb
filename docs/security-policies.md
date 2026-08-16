# Security analysis policies

This page says how the project handles findings from the scanners that watch
the codebase, and what has to be true before a release ships. The scanners
themselves are listed in the [assurance case](./assurance-case.md).

## Dependency analysis (SCA)

Dependabot opens weekly grouped update pull requests for npm dependencies and
GitHub Actions. Socket and the OpenSSF Scorecard provide outside views of the
same surface; Socket scans pull requests that change the dependency manifests
(`package.json`, `package-lock.json`), which is the only surface it ingests.
On top of that, every pull request runs a `dependency audit` check (`npm
audit` against the production tree, with the advisory registry pinned to
registry.npmjs.org) that fails on high or critical advisories, and the check
is required by the branch ruleset, so a change cannot merge while it
introduces a known-vulnerable production dependency.

Remediation thresholds, counted from when an advisory becomes known:

| Severity | Target                                                                       |
| -------- | ---------------------------------------------------------------------------- |
| Critical | Fix or dismiss with justification within 7 days, and before the next release |
| High     | Within 14 days, and before the next release                                  |
| Moderate | Within 30 days                                                               |
| Low      | Best effort, reviewed at the next release                                    |

A release does not ship while a critical or high dependency finding is open
against the production tree. Dev-only findings do not block a release but
follow the same timelines. The production tree is deliberately small: one
runtime dependency, with Prisma as a peer dependency supplied by the
application.

License policy: runtime dependencies must carry OSI-approved permissive
licenses compatible with MIT. A dependency that changes to an incompatible
license is treated as a critical finding and replaced.

## Secrets and credentials

The project is designed to hold as few secrets as possible:

- Publishing needs no stored credential. npm releases use OIDC trusted
  publishing from GitHub Actions, so there is no npm token to store, leak, or
  rotate.
- The only standing secret is the Codecov upload token, kept as a GitHub
  Actions repository secret. It can only upload coverage reports; it grants no
  access to code, accounts, or publishing.
- Secrets are never hard-coded or committed. GitHub secret scanning runs on
  the repository, and local artifacts are gitignored.
- Access to repository secrets requires admin access to the repository, which
  is governed by the escalated-permissions policy in
  [GOVERNANCE.md](../GOVERNANCE.md).
- Rotation: the Codecov token is rotated from the Codecov dashboard whenever
  exposure is suspected and whenever repository access changes. A secret that
  gains broader scope than described here must be documented in this section
  first.

## Exploitability assessments (VEX)

When a scanner reports a vulnerability in a component that does not actually
affect this package (for example, code that is never reached, or a dev-only
dependency), the assessment is recorded instead of silently dismissed. Each
such finding gets a statement here with the advisory ID, the affected
component, the verdict, and the reasoning, and the corresponding alert is
dismissed with the same justification so the two records match.

Current statements: none. There are no open component vulnerabilities
assessed as not affecting the project (last reviewed 2026-08-15). Recent
history of the process, for the record: the dev-scope undici
(GHSA-8xcm-r25x-g524 and related), protobufjs (GHSA-j3f2-48v5-ccww), and
valibot (GHSA-5qjj-4xww-7phc) advisories were removed by the dependency
upgrades in [#82](https://github.com/Krister-Johansson/prisma-extension-timescaledb/pull/82),
and brace-expansion (GHSA-3jxr-9vmj-r5cp and related) by
[#89](https://github.com/Krister-Johansson/prisma-extension-timescaledb/pull/89),
rather than assessed away. One dev-scope low remains open: esbuild
(GHSA-g7r4-m6w7-qqqr, Windows-only dev-server file read), pinned inside
tsup's dependency range and tracked for the next tsup upgrade.

## Static analysis (SAST)

CodeQL scans every pull request and push to `main` (javascript-typescript).
TypeScript `strict` mode runs in the required CI checks and fails the build on
any error, and an automated review runs on every pull request.

Remediation thresholds for code scanning alerts:

| Severity         | Target                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Critical or high | Fix before merge when introduced by the change; otherwise within 14 days and before the next release |
| Medium           | Within 30 days                                                                                       |
| Low              | Best effort, reviewed at the next release                                                            |

An alert is only ever closed by fixing it or by dismissing it with a written
justification on the alert itself. Dismissals without reasoning are not
acceptable.
