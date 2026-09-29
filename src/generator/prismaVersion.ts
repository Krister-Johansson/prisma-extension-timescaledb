// The Prisma major this release of the generator understands. The DMMF the generator reads is
// an internal, non-SemVer API (CLAUDE.md), so a Prisma major outside the range must stop with a
// message that names the versions, not with a TypeError deep inside extractTimescaleSchema.
// The client extension is not affected: it uses only public Prisma APIs and keeps working with
// a manual config, which is why the peer ranges stay open.
import { createRequire } from "node:module";

export const SUPPORTED_PRISMA_MAJOR = 7;

/**
 * The version of the `prisma` package installed next to the generator, resolved from the
 * generator's own location (`import.meta.url` of the calling module) so it is the consumer's
 * copy: prisma is a peer, installed beside this package under npm and linked beside it under
 * pnpm. Undefined when nothing resolves, which happens with a globally installed CLI and no
 * local prisma; the CLI that spawned the generator is then unknown, since Prisma passes only
 * an engine hash, and the caller warns instead of guarding.
 */
export function installedPrismaVersion(fromUrl: string): string | undefined {
  try {
    const require = createRequire(fromUrl);
    return (require("prisma/package.json") as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * Throw when `version` (the installed `prisma` package's version) is outside the supported
 * major. A pre-release of the supported major passes. An unparseable version is left alone,
 * since refusing to run on an odd build string would help nobody. Returns a warning instead of
 * throwing when the version is unknown, so the caller can print it.
 */
export function assertSupportedPrismaVersion(version: string | undefined): string | undefined {
  if (version === undefined) {
    return `prisma-extension-timescaledb: could not find the installed prisma package from the generator's location, so its version was not checked. This release of the generator supports Prisma ${SUPPORTED_PRISMA_MAJOR}.x; a different major can fail while reading the schema.`;
  }
  const major = /^(\d+)\./.exec(version)?.[1];
  if (major === undefined) return undefined;
  const installed = Number(major);
  if (installed === SUPPORTED_PRISMA_MAJOR) return undefined;
  const supported = `${SUPPORTED_PRISMA_MAJOR}.x`;
  const remedy =
    installed < SUPPORTED_PRISMA_MAJOR
      ? `Upgrade prisma and @prisma/client to ${supported}.`
      : `Install a newer prisma-extension-timescaledb release that supports Prisma ${installed}, or pin prisma to ${supported}. The client extension keeps working with a manual config in the meantime.`;
  throw new Error(
    `prisma-extension-timescaledb: prisma ${version} is installed, but this release of the generator supports Prisma ${supported} only (the schema it reads is an internal Prisma API). ${remedy}`,
  );
}
