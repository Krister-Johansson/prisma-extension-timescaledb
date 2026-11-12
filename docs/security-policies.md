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

The project holds as few secrets as possible:

- Publishing needs no stored credential. npm releases use OIDC trusted
  publishing from GitHub Actions, so there is no npm token to store, leak, or
  rotate. The npm token that predated trusted publishing was revoked and its
  repository secret deleted on 2026-09-29.
- Three standing secrets exist, all GitHub Actions repository secrets:
  - `CODECOV_TOKEN` uploads coverage reports to Codecov. It grants no access
    to code, accounts, or publishing. Rotate it from the Codecov dashboard.
  - `RELEASE_PLEASE_TOKEN` is a fine-grained personal access token scoped to
    this repository only, with read and write on contents and pull requests.
    release-please uses it to maintain the release pull request and to create
    tags and releases, so that the release event reaches the SBOM workflow
    (an event raised with the workflow's own token would not). The release
    workflow fails when the secret is missing or empty rather than falling
    back to the workflow token. Fine-grained tokens expire; renew it from the
    GitHub token settings before the expiry date and replace the secret.
  - `SCORECARD_TOKEN` is a fine-grained personal access token with read
    access to repository administration, which the Scorecard action needs to
    read branch protection. It falls back to the workflow token, which loses
    only that one check.
- Secrets are never hard-coded or committed. GitHub secret scanning runs on
  the repository, and local artifacts are gitignored.
- Access to repository secrets requires admin access to the repository, which
  is governed by the escalated-permissions policy in
  [GOVERNANCE.md](../GOVERNANCE.md).
- Rotation: every secret is rotated whenever exposure is suspected and
  whenever repository access changes. A secret that gains broader scope than
  described here must be documented in this section first.

## Exploitability assessments (VEX)

When a scanner reports a vulnerability in a component that does not actually
affect this package (for example, code that is never reached, or a dev-only
dependency), the assessment is recorded instead of silently dismissed. Each
such finding gets a statement here with the advisory ID, the affected
component, the verdict, and the reasoning, and the corresponding alert is
dismissed with the same justification so the two records match.

Current statements (last reviewed 2026-11-13):

| Advisory | Component | Verdict |
| --- | --- | --- |
| GHSA-3g3m-2fjr-6pw4 | glob 10.5.0 | Not affected: vulnerable code is not in the execute path |
| GHSA-g3hv-75wg-m249 | minimatch 9.0.9 | Not affected: vulnerable code is not in the execute path |

Both sit in the development tree under testcontainers > archiver 7 >
archiver-utils, and neither is in the published package, whose production
tree is one runtime dependency. minimatch 9.0.9 is installed only as a
dependency of that glob. archiver-utils uses glob in its file-expansion
helpers; archiver itself walks directories with readdir-glob. Testcontainers
calls archiver only from its copy-to-container functions, and the integration
tests never call those, so no test run reaches the glob code and no glob
pattern comes from outside the repository. No update is available to take:
the fixes are in glob 14.0.2 and minimatch 11.0.1, archiver-utils requires
glob ^10, and testcontainers 12.2.1 still requires archiver ^7.0.1 (archiver
8 no longer depends on archiver-utils). The same assessment is in
`osv-scanner.toml` at the repository root, which the Scorecard
Vulnerabilities check reads, and on the dismissed Dependabot alert for
minimatch (Dependabot auto-dismissed the glob alert). Both statements and the `osv-scanner.toml` entries are removed when
testcontainers moves to archiver 8
([#187](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/187)).

Recent history of the process, for the record: the dev-scope undici
(GHSA-8xcm-r25x-g524 and related), protobufjs (GHSA-j3f2-48v5-ccww), and
valibot (GHSA-5qjj-4xww-7phc) advisories were removed by the dependency
upgrades in [#82](https://github.com/Krister-Johansson/prisma-extension-timescaledb/pull/82),
brace-expansion (GHSA-3jxr-9vmj-r5cp and related) by
[#89](https://github.com/Krister-Johansson/prisma-extension-timescaledb/pull/89),
and the dev-scope deepmerge-ts (GHSA-ggr8-5vv4-36mx) and esbuild
(GHSA-g7r4-m6w7-qqqr) advisories by npm overrides in
[#102](https://github.com/Krister-Johansson/prisma-extension-timescaledb/pull/102)
(the overrides were removed again under
[#103](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/103)
once Prisma 7.10.1 and tsup 9 required the patched versions themselves),
rather than assessed away.

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
