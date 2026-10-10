/** Throws an `Error` whose message starts with the library name. */
export const fail = (message: string): never => {
  throw new Error(`betternodes: ${message}`)
}
