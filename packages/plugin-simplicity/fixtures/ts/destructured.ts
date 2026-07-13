interface Doc {
  author: string
  title: string
}

export function readAuthor(doc: Doc): string {
  const { author } = doc

  return author
}

/*
 * The `accessors.ts` trap, in the form TypeScript actually writes it. Both must stay silent.
 *
 * Destructuring spells the property and declares the local in one token, so an extractor that
 * files that token under "names this function declares" blinds it away. These two return the
 * same type, which leaves the property as the only thing telling them apart, so blinding it
 * makes them the same function and the AST approach reports them as copies of each other.
 *
 * Two statements each, so `no-needless-helper` never asks about them. No model decides this.
 */
export function readTitle(doc: Doc): string {
  const { title } = doc

  return title
}
