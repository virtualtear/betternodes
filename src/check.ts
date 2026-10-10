/** Throws an `Error` whose message starts with the library name. */
export const fail = (message: string): never => {
  throw new Error(`betternodes: ${message}`)
}

/**
 * Throws unless every name is one CSS class.
 * @remarks `classList.add()` throws for `''` and for names with whitespace. Inside a frame that
 * would break rendering for good, so names are checked where they come in.
 */
export function checkClasses(names: readonly string[]) {
  // The DOM's own rule: not empty, no ASCII whitespace.
  for (const name of names) if (typeof name !== 'string' || !/^[^\t\n\f\r ]+$/.test(name)) fail(`invalid CSS class "${name}"`)
}
