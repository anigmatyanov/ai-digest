/**
 * Checks a migration file can be judged by without a database.
 *
 * A separate module rather than an export from db-status.mjs: that script runs on import
 * and ends in process.exit, so a test importing it would kill the test runner. The rule
 * generalises — anything worth testing does not live in a file that executes itself.
 */

/**
 * The one ordering constraint worth asserting mechanically: a vector(384) column cannot be
 * declared before the extension that defines the type, and Postgres will refuse the whole
 * migration if it is.
 *
 * Comment lines are stripped first. Without that, prose ABOUT the ordering trips the check
 * that enforces it — which is what happened the first time this ran: the migration's own
 * header explains why the extension comes first, and the words "vector(384)" in that
 * sentence sat above CREATE EXTENSION.
 *
 * @returns a description of the problem, or null when the file is fine.
 */
export function vectorOrderingProblem(sql, extensionAlreadyCreated = false) {
  const statements = String(sql)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const ext = statements.indexOf("CREATE EXTENSION");
  const firstVector = statements.indexOf("vector(");
  if (firstVector === -1) return null;
  // A LATER migration may add a vector column while an EARLIER one created the extension.
  // Judging each file in isolation reported the second such migration as broken — a check
  // that would have gone red on a correct set the first time anyone added one.
  if (ext === -1) {
    return extensionAlreadyCreated
      ? null
      : "declares a vector column but never creates the vector extension";
  }
  if (ext > firstVector) return "a vector column appears before CREATE EXTENSION vector";
  return null;
}
