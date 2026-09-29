// The Prisma major this release of the generator understands. The DMMF the generator reads is
// an internal, non-SemVer API (CLAUDE.md), so a Prisma major outside the range must stop with a
// message that names the versions, not with a TypeError deep inside extractTimescaleSchema.
// The client extension is not affected: it uses only public Prisma APIs and keeps working with
// a manual config, which is why the peer ranges stay open.
export const SUPPORTED_PRISMA_MAJOR = 7;

/**
 * Throw when `version` (the installed `prisma` package's version) is outside the supported
 * major. A pre-release of the supported major passes. An unparseable version is left alone,
 * since refusing to run on an odd build string would help nobody.
 */
export function assertSupportedPrismaVersion(version: string | undefined): void {
  if (version === undefined) return;
  const major = /^(\d+)\./.exec(version)?.[1];
  if (major === undefined) return;
  if (Number(major) !== SUPPORTED_PRISMA_MAJOR) {
    throw new Error(
      `prisma-extension-timescaledb: prisma ${version} is installed, but this release of the generator supports Prisma ${SUPPORTED_PRISMA_MAJOR}.x only (the schema it reads is an internal Prisma API). Install a prisma-extension-timescaledb release that supports Prisma ${major}, or pin prisma to ${SUPPORTED_PRISMA_MAJOR}.x. The client extension keeps working with a manual config in the meantime.`,
    );
  }
}
