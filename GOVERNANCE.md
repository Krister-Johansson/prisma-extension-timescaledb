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
protected `main` branch with required CI: build and tests on Node 20 and 22, an
integration suite against a real TimescaleDB, and a linked-issue check. An
automated review also runs on every pull request, and the maintainer waits for
it before merging, though it is not a required status check. Releases are automated with release-please and published to
npm from CI via trusted publishing; no human holds or uses an npm token. The
process is described in [CONTRIBUTING.md](./CONTRIBUTING.md) and enforced by
branch protection.

## Continuity

Practical safeguards if the maintainer is unavailable:

- Publishing needs no personal secrets. npm releases use OIDC trusted
  publishing from GitHub Actions, so there is no token to lose or leak.
- Repository access is protected by GitHub's account security requirements for
  contributors, and standard account recovery applies.
- The build, test, and release workflows live in this repository, partly as
  thin callers of pinned reusable workflows in
  [Krister-Johansson/shared-configs](https://github.com/Krister-Johansson/shared-configs);
  vendoring them fully into this repository is planned. Publishing also
  depends on the Trusted Publisher registration for this repository on
  npmjs.com. The MIT license lets any user fork and continue the project if
  it goes quiet, re-registering publishing for their fork.

If the maintainer expects to be unreachable for an extended period, the plan is
to say so in a pinned issue and, if the absence is long, to add a co-maintainer
or transfer the repository and npm package to a successor.
