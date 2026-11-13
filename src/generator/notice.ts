// How the generator talks to the person running `prisma generate`.
//
// Prisma spawns a generator with stdin and stderr piped and stdout inherited. stderr carries
// the JSON-RPC responses; Prisma keeps every other line written there and prints it only when
// the generator fails. A message written with console.warn on a successful run is therefore
// never shown (issue #192). stdout goes straight to the terminal, so notices are written there.

/** Print a notice the user must see on a successful `prisma generate`. */
export function notice(message: string): void {
  process.stdout.write(`${message}\n`);
}
