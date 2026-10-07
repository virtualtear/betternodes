/** A directed wire between two refs: `'nodeId.anchor'`, or a bare `'nodeId'` for a floating end. */
export type Edge = [from: string, to: string]

/** Serializable editor state: everything a user can change in edit mode. */
export interface State {
  positions: Record<string, [number, number]>
  edges: Edge[]
  /** Ids of nodes the user deleted; only present when there are any. */
  removed?: string[]
}

/** What a user edit changed; enough to persist edits incrementally. */
export interface Diff {
  added: Edge[]
  removed: Edge[]
  /** New positions of nodes that moved. */
  moved: Record<string, [number, number]>
  /** Nodes the user deleted. */
  nodesRemoved: string[]
  /** Deleted nodes that came back, e.g. through undo. */
  nodesRestored: string[]
}

/** Map key of the wire from `from` to `to`. */
export const wireKey = (from: string, to: string) => `${from}>${to}`

const without = <T>(items: Iterable<T>, drop: Set<T>) => [...items].filter(item => !drop.has(item))

/** Compares two states: wires by key, positions by value. */
export function diff(before: State, after: State): Diff {
  const keys = (s: State) => new Set(s.edges.map(e => wireKey(...e)))
  const [had, has] = [keys(before), keys(after)]
  const moved: Diff['moved'] = {}
  for (const [id, [x, y]] of Object.entries(after.positions)) {
    const old = before.positions[id]
    if (!old || old[0] !== x || old[1] !== y) moved[id] = [x, y]
  }
  const [wasGone, isGone] = [new Set(before.removed), new Set(after.removed)]
  return {
    added: after.edges.filter(e => !had.has(wireKey(...e))),
    removed: before.edges.filter(e => !has.has(wireKey(...e))),
    moved,
    nodesRemoved: without(isGone, wasGone),
    nodesRestored: without(wasGone, isGone),
  }
}
