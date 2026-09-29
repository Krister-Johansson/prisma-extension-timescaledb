# Governance

prisma-extension-timescaledb is a small open-source project with a single
maintainer. This document says plainly how it is run, so nobody has to guess.

## Roles

**Maintainer**: [Krister Johansson](https://github.com/Krister-Johansson). The
maintainer sets the roadmap, reviews and merges pull requests, triages issues,
handles security reports, and publishes releases.

**Contributors**: anyone who opens an issue or a pull request. Contributions are
reviewed against [CONTRIBUTING.md](./CONTRIBUTING.md). There is no formal
membership; a contribution is judged on its content, not on who sent it.

There are currently no other committer roles. If the project grows enough that
review becomes a bottleneck, the maintainer will invite regular contributors to
become committers and update this document.

Nobody is granted escalated permissions (write access, merge approval, access
to repository settings or secrets) without review first. Before any such grant,
the maintainer reviews the person's contribution history in this project,
confirms the account's identity well enough to trust it (for example an
established public track record or a known affiliation), and records the grant
and its reasoning in an issue. The same applies to revocation: access that is
no longer needed is removed.

## How decisions are made

Decisions about scope, design, and releases are made by the maintainer, in
public. Substantial changes start as a GitHub issue where anyone can comment
before code is written. Disagreements are worked out in the issue thread. The
maintainer has the final say, and the MIT license means anyone who disagrees
strongly enough can fork.

## Change process

All changes, including the maintainer's own, go through pull requests against a
protected `main` branch. The `main-protection` ruleset requires six status
checks: build and tests on Node 20 and 22, the integration suite against a
real TimescaleDB, the linked-issue check, the dependency audit and CodeQL. A
Node 24 job runs in the same matrix without being required. The ruleset also
requires every review thread to be resolved before a merge and blocks force
pushes and branch deletion. An automated review (CodeRabbit) runs on every
pull request, and the maintainer waits for it before merging, though it is not
a required status check. Releases are automated with release-please and
published to npm from CI via trusted publishing; no human holds or uses an npm
token. The process is described in [CONTRIBUTING.md](./CONTRIBUTING.md) and
enforced by the ruleset.

Three ruleset choices follow from the single-maintainer model. There is no
required reviewer count, because there is nobody to review the maintainer's
pull requests; the automated review and the required checks stand in for it.
Commit signing is not required, because release provenance comes from the
CI-side signing of releases and SBOMs rather than from commit signatures. The
ruleset has no bypass actors, so the maintainer's own changes go through the
same checks as everyone else's.

## Continuity

Practical safeguards if the maintainer is unavailable:

- Publishing needs no personal secrets. npm releases use OIDC trusted
  publishing from GitHub Actions, so there is no token to lose or leak.
- Repository access is protected by GitHub's account security requirements for
  contributors, and standard account recovery applies.
- The build, test, and release workflows live in this repository in full,
  with every action pinned to a commit. The only external configuration file
  is `.coderabbit.yaml`, which pulls the automated-review settings from
  [Krister-Johansson/shared-configs](https://github.com/Krister-Johansson/shared-configs);
  losing it would only change how the review bot behaves. Outside the
  repository, publishing depends on the Trusted Publisher registration for
  this repository on npmjs.com. The MIT license lets any user fork and continue the project if
  it goes quiet, re-registering publishing for their fork.

If the maintainer expects to be unreachable for an extended period, the plan is
to say so in a pinned issue and, if the absence is long, to add a co-maintainer
or transfer the repository and npm package to a successor.
