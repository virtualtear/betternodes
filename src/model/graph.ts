/** A node as defined in code; x/y are world coordinates. */
export interface NodeDef {
  id: string
  title: string
  x: number
  y: number
  content?: HTMLElement
  /** Extra CSS classes, e.g. a status like `'error'`. */
  classes?: string[]
  /** Whether x/y were set explicitly (code, saved state or a drag); auto-layout skips these. */
  placed?: boolean
}

/** Anchor names: a node's corners and edge midpoints, by compass direction. */
export type Anchor = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** Connection points on a node's border, as fractions of its width and height. */
export const ANCHORS: Record<Anchor, [fx: number, fy: number]> = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
}

/** A directed wire between two anchor refs, both `'nodeId.anchor'`. */
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

/** Compares two states: wires by `from>to` key, positions by value. */
export function diff(before: State, after: State): Diff {
  const keys = (s: State) => new Set(s.edges.map(e => e.join('>')))
  const [had, has] = [keys(before), keys(after)]
  const moved: Diff['moved'] = {}
  for (const [id, [x, y]] of Object.entries(after.positions)) {
    const old = before.positions[id]
    if (!old || old[0] !== x || old[1] !== y) moved[id] = [x, y]
  }
  const [wasGone, isGone] = [new Set(before.removed), new Set(after.removed)]
  return {
    added: after.edges.filter(e => !had.has(e.join('>'))),
    removed: before.edges.filter(e => !has.has(e.join('>'))),
    moved,
    nodesRemoved: [...isGone].filter(id => !wasGone.has(id)),
    nodesRestored: [...wasGone].filter(id => !isGone.has(id)),
  }
}

/** Node id of a `'nodeId.anchor'` ref; node ids contain no dots, so the first dot splits. */
export const nodeOf = (ref: string) => ref.split('.', 1)[0]

/** Anchor name of a `'nodeId.anchor'` ref. */
export const anchorOf = (ref: string) => ref.slice(ref.indexOf('.') + 1) as Anchor

/** Pure graph model, no DOM. */
export class Graph {
  nodes = new Map<string, NodeDef>()
  // Keyed by `from>to`, so duplicates collapse for free.
  edges = new Map<string, Edge>()
  // Deleted nodes keep their definition here, so undo or load() can bring them back.
  trash = new Map<string, NodeDef>()
  // Notes on wires, by `from>to` key, set from code. They outlive their wire, so a wire that undo
  // or load() brings back gets its note back too.
  labels = new Map<string, string>()
  // Extra CSS classes on wires, by `from>to` key, set from code; they outlive their wire like notes.
  classes = new Map<string, string[]>()
  /** Bumped on every change to wires or nodes, so derived lookups know when to rebuild. */
  version = 0

  /** True if both refs name existing anchors or nodes, on different nodes, and the wire is new. */
  canConnect(from: string, to: string) {
    return this.has(from) && this.has(to) && nodeOf(from) !== nodeOf(to) && !this.edges.has(`${from}>${to}`)
  }

  /** @throws if {@link Graph.canConnect} rejects the wire. */
  connect(from: string, to: string) {
    if (!this.canConnect(from, to)) throw new Error(`betternodes: invalid wire ${from} -> ${to}`)
    this.edges.set(`${from}>${to}`, [from, to])
    this.version++
  }

  /**
   * Trashes or restores nodes to match `state.removed`, applies saved positions to known nodes and
   * replaces all wires, skipping invalid ones.
   */
  load(state: State) {
    this.version++
    const removed = new Set(state.removed)
    for (const id of removed) this.remove(id)
    for (const [id, n] of this.trash) {
      if (removed.has(id)) continue
      this.trash.delete(id)
      this.nodes.set(id, n)
    }
    for (const [id, [x, y]] of Object.entries(state.positions)) {
      const n = this.nodes.get(id)
      if (n) Object.assign(n, { x, y, placed: true })
    }
    this.edges.clear()
    for (const [from, to] of state.edges) {
      if (this.canConnect(from, to)) this.connect(from, to)
      else console.warn(`betternodes: dropped saved wire ${from} -> ${to}`)
    }
  }

  /** Moves a node to the trash and deletes its wires; returns false for an unknown id. */
  remove(id: string) {
    const n = this.nodes.get(id)
    if (!n) return false
    this.nodes.delete(id)
    this.trash.set(id, n)
    this.version++
    for (const [key, [from, to]] of this.edges) if (nodeOf(from) === id || nodeOf(to) === id) this.edges.delete(key)
    return true
  }

  /** Sets the note on the wire from `from` to `to`; no text removes it. */
  label(from: string, to: string, text?: string) {
    if (text) this.labels.set(`${from}>${to}`, text)
    else this.labels.delete(`${from}>${to}`)
    this.version++
  }

  /** Sets the extra CSS classes of the wire from `from` to `to`, replacing earlier ones; none clears them. */
  classify(from: string, to: string, names: string[]) {
    if (names.length) this.classes.set(`${from}>${to}`, [...names])
    else this.classes.delete(`${from}>${to}`)
    this.version++
  }

  /** @returns false if there was no such wire. */
  disconnect(from: string, to: string) {
    this.version++
    return this.edges.delete(`${from}>${to}`)
  }

  // A ref is `'nodeId.anchor'`, or a bare `'nodeId'` whose anchor the view picks per render.
  private has(ref: string) {
    return this.nodes.has(nodeOf(ref)) && (!ref.includes('.') || Object.hasOwn(ANCHORS, anchorOf(ref)))
  }

  toState(): State {
    const positions: State['positions'] = {}
    for (const n of this.nodes.values()) positions[n.id] = [n.x, n.y]
    const state: State = { positions, edges: [...this.edges.values()].map(([from, to]) => [from, to]) }
    if (this.trash.size) state.removed = [...this.trash.keys()]
    return state
  }
}
