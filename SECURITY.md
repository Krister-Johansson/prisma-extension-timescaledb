# Security policy

## Supported versions

`prisma-extension-timescaledb` follows semantic versioning. Security fixes are
released against the latest published version, so upgrade before reporting.

| Version        | Supported |
| -------------- | --------- |
| latest release | Yes       |
| older releases | No        |

Support covers bug fixes and security updates for the latest release only. A
release stops receiving security updates the moment a newer release is
published; there are no long-term support branches.

## Verifying a release

npm releases are published from GitHub Actions through OIDC trusted publishing
with provenance, so you can check both integrity and origin:

```bash
npm audit signatures
```

The command needs npm 9.5.0 or newer and installed dependencies
(`npm install` or `npm ci`). It verifies the registry signatures and Sigstore provenance
attestations of your installed packages, `prisma-extension-timescaledb`
included, and reports how many packages have verified attestations. You can
also inspect the provenance on the package's npm page, which shows the source
commit, workflow, and build log for each version.

The expected identity in the attestation is this repository:
`Krister-Johansson/prisma-extension-timescaledb`, built by GitHub Actions from
the release-please workflow. Treat any version whose provenance names a
different repository or builder as compromised, and report it.

## Reporting a vulnerability

Do not open a public issue for security problems.

Report vulnerabilities privately through GitHub's
[Report a vulnerability](https://github.com/Krister-Johansson/prisma-extension-timescaledb/security/advisories/new)
form (repository Security → Advisories). This opens a private channel with the
maintainer.

What to expect:

- An acknowledgement within 5 business days.
- If confirmed, a fix and a coordinated-disclosure timeline. Credit is given in
  the advisory unless you prefer to remain anonymous.

## Scope

This package generates SQL migrations and runs typed queries against
TimescaleDB through Prisma. The most relevant reports concern SQL injection in
the generated SQL or the `timeBucket` query helpers, and unsafe handling of
user-supplied identifiers or values.

The published package ships only `dist/` and depends on Prisma at runtime.
Report issues in Prisma itself to the
[Prisma project](https://github.com/prisma/prisma/security).
