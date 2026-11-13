// The Prisma major this release of the generator understands. The DMMF the generator reads is
// an internal, non-SemVer API (CLAUDE.md), so a Prisma major outside the range must stop with a
// message that names the versions, not with a TypeError deep inside extractTimescaleSchema.
// The peer ranges in package.json stop below the next major for the same reason, and because
// Prisma 8 has neither generators nor $extends, so nothing in this package runs on it.
import { createRequire } from "node:module";

export const SUPPORTED_PRISMA_MAJOR = 7;

// Prisma publishes the previous major's CLI as a wrapper package for its incremental upgrade
// path: @prisma/prisma7 (binary `prisma7`) installed beside a root `prisma` 8.
const WRAPPER_PACKAGE = `@prisma/prisma${SUPPORTED_PRISMA_MAJOR}`;

function majorOf(version: string): number | undefined {
  const major = /^(\d+)\./.exec(version)?.[1];
  return major === undefined ? undefined : Number(major);
}

function packageVersion(fromUrl: string, name: string): string | undefined {
  try {
    return (createRequire(fromUrl)(`${name}/package.json`) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * The version of the Prisma CLI installed next to the generator, resolved from the
 * generator's own location (`import.meta.url` of the calling module) so it is the consumer's
 * copy: prisma is a peer, installed beside this package under npm and linked beside it under
 * pnpm. Undefined when nothing resolves, which happens with a globally installed CLI and no
 * local prisma; the CLI that spawned the generator is then unknown, since Prisma passes only
 * an engine hash, and the caller warns instead of guarding.
 *
 * When the root `prisma` is a newer major, or absent, and the wrapper package for the supported
 * major is installed, the wrapper's version is returned. That is Prisma's side-by-side upgrade
 * layout, where the root `prisma` is 8 and has no generator protocol, so the CLI that spawned
 * the generator is the wrapper's. An older root `prisma` is still reported as it is, because
 * that CLI can spawn the generator itself.
 */
export function installedPrismaVersion(fromUrl: string): string | undefined {
  const root = packageVersion(fromUrl, "prisma");
  const rootMajor = root === undefined ? undefined : majorOf(root);
  if (rootMajor !== undefined && rootMajor <= SUPPORTED_PRISMA_MAJOR) return root;
  const wrapper = packageVersion(fromUrl, WRAPPER_PACKAGE);
  if (wrapper !== undefined && majorOf(wrapper) === SUPPORTED_PRISMA_MAJOR) return wrapper;
  return root;
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
  const installed = majorOf(version);
  if (installed === undefined || installed === SUPPORTED_PRISMA_MAJOR) return undefined;
  const supported = `${SUPPORTED_PRISMA_MAJOR}.x`;
  const remedy =
    installed < SUPPORTED_PRISMA_MAJOR
      ? `Upgrade prisma and @prisma/client to ${supported}.`
      : `Pin prisma and @prisma/client to ${supported}: npm install -D prisma@${SUPPORTED_PRISMA_MAJOR} @prisma/client@${SUPPORTED_PRISMA_MAJOR}.`;
  throw new Error(
    `prisma-extension-timescaledb: prisma ${version} is installed, but this release of the generator supports Prisma ${supported} only (the schema it reads is an internal Prisma API). ${remedy}`,
  );
}
