import { wireKey, type Edge, type State } from './state'

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

/** A group as defined in code: a titled frame drawn around its member nodes. */
export interface GroupDef {
  id: string
  title: string
  classes?: string[]
}

/** Connection points on a node's border by compass name, as fractions of its width and height. */
export const ANCHORS = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
} as const satisfies Record<string, readonly [fx: number, fy: number]>

/** Anchor names: a node's corners and edge midpoints, by compass direction. */
export type Anchor = keyof typeof ANCHORS

export const isAnchor = (name: string): name is Anchor => Object.hasOwn(ANCHORS, name)

/** Node id of a ref; node ids contain no dots, so the first dot splits. */
export const nodeOf = (ref: string) => ref.split('.', 1)[0]

/** Anchor name of a `'nodeId.anchor'` ref. */
export const anchorOf = (ref: string) => ref.slice(ref.indexOf('.') + 1) as Anchor

/** Pure graph model, no DOM. */
export class Graph {
  readonly nodes = new Map<string, NodeDef>()
  readonly edges = new Map<string, Edge>()
  /** Deleted nodes, kept so undo or `load()` can bring them back. */
  readonly trash = new Map<string, NodeDef>()
  /** Wire notes by wire key; they outlive their wire, so a wire brought back gets its note back. */
  readonly labels = new Map<string, string>()
  /** Extra CSS classes by wire key; they outlive their wire like notes. */
  readonly classes = new Map<string, string[]>()
  readonly groups = new Map<string, GroupDef>()
  /** Group id per node id, so a node is in at most one group. Kept for deleted nodes too. */
  readonly memberOf = new Map<string, string>()
  /** Bumped on every change to wires or nodes, so derived lookups know when to rebuild. */
  version = 0

  /** True if both refs name existing anchors or nodes, on different nodes, and the wire is new. */
  canConnect(from: string, to: string) {
    return this.has(from) && this.has(to) && nodeOf(from) !== nodeOf(to) && !this.edges.has(wireKey(from, to))
  }

  /** @throws if {@link Graph.canConnect} rejects the wire. */
  connect(from: string, to: string) {
    if (!this.canConnect(from, to)) throw new Error(`betternodes: invalid wire ${from} -> ${to}`)
    this.edges.set(wireKey(from, to), [from, to])
    this.version++
  }

  /** @returns false if there was no such wire. */
  disconnect(from: string, to: string) {
    this.version++
    return this.edges.delete(wireKey(from, to))
  }

  /** Trashes or restores nodes to match `state.removed`, moves known nodes and replaces all wires. */
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

  /** Sets the note on a wire; no text removes it. */
  label(from: string, to: string, text?: string) {
    this.patch(this.labels, wireKey(from, to), text || undefined)
  }

  /** Sets the extra CSS classes of a wire, replacing earlier ones; none clears them. */
  classify(from: string, to: string, names: string[]) {
    this.patch(this.classes, wireKey(from, to), names.length ? [...names] : undefined)
  }

  /** Makes `ids` the members of `group`, taking them out of any other group. */
  setMembers(group: string, ids: string[]) {
    for (const [id, g] of this.memberOf) if (g === group) this.memberOf.delete(id)
    for (const id of ids) this.memberOf.set(id, group)
  }

  /** Member ids of every group that has members shown. */
  members() {
    const out = new Map<string, string[]>()
    for (const [id, g] of this.memberOf) {
      if (!this.nodes.has(id)) continue
      const list = out.get(g)
      if (list) list.push(id)
      else out.set(g, [id])
    }
    return out
  }

  toState(): State {
    const positions: State['positions'] = {}
    for (const n of this.nodes.values()) positions[n.id] = [n.x, n.y]
    const state: State = { positions, edges: [...this.edges.values()].map(([from, to]) => [from, to]) }
    if (this.trash.size) state.removed = [...this.trash.keys()]
    return state
  }

  // A bare node id is a valid ref too: the view picks its anchor per render.
  private has(ref: string) {
    return this.nodes.has(nodeOf(ref)) && (!ref.includes('.') || isAnchor(anchorOf(ref)))
  }

  private patch<V>(map: Map<string, V>, key: string, value: V | undefined) {
    if (value === undefined) map.delete(key)
    else map.set(key, value)
    this.version++
  }
}
