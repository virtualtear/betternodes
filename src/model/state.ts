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

declare const wire: unique symbol

/** A wire's key in the graph's maps; only {@link wireKey} makes one, so a ref can't pass for it. */
export type WireKey = string & { readonly [wire]: true }

/** Map key of the wire from `from` to `to`; unique because node ids contain no `>`. */
export const wireKey = (from: string, to: string) => `${from}>${to}` as WireKey
