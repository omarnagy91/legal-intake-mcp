/**
 * Citation anchors.
 *
 * These live in their own module so that both the loader and the clause
 * segmenter can produce anchors without importing each other. There is exactly
 * one definition of each anchor format in the codebase, which is what makes the
 * guarantee that every tool reports the same anchor for the same text hold.
 */

/** Paragraph citation handle, for example "P12". */
export function paragraphAnchor(index: number): string {
  return `P${index}`;
}

/** Clause citation handle, for example "C7". */
export function clauseAnchor(index: number): string {
  return `C${index}`;
}
