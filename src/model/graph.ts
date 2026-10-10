import { WORLD } from '../geometry/rect'
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
export function nodeOf(ref: string) {
  // Not split(), which builds an array per call: the wire loop calls this twice per wire per frame.
  const dot = ref.indexOf('.')
  return dot < 0 ? ref : ref.slice(0, dot)
}

/** Anchor name of a `'nodeId.anchor'` ref. */
export const anchorOf = (ref: string) => ref.slice(ref.indexOf('.') + 1) as Anchor

const warn = (message: string) => console.warn(`betternodes: dropped saved ${message}`)

// Numbers are checked against WORLD, not just for being finite: JSON turns 1e309 into Infinity, and
// coordinates beyond 2^53 stop grid loops from advancing.
const isPosition = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every(c => typeof c === 'number' && Math.abs(c) <= WORLD)

const isEdge = (v: unknown): v is Edge => Array.isArray(v) && v.length === 2 && v.every(end => typeof end === 'string')

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// The entries that pass `ok`. One counted warning covers the rest, so a huge crafted list can't flood
// the console.
function valid<E, T extends E>(entries: E[], ok: (entry: E) => entry is T, what: string): T[] {
  const out = entries.filter(ok)
  if (out.length < entries.length) warn(`${what}: ${entries.length - out.length} malformed`)
  return out
}

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
    const had = this.edges.delete(wireKey(from, to))
    // Only real changes: a bump makes the next frame re-check every wire.
    if (had) this.version++
    return had
  }

  /**
   * Trashes or restores nodes to match `state.removed`, moves known nodes and replaces all wires.
   * @remarks Saved state often comes from storage or a server, so it is checked before anything
   * changes: a state of the wrong shape is ignored, malformed entries and coordinates beyond
   * {@link WORLD} are dropped, each with a warning.
   * @returns false if the state was ignored.
   */
  load(state: unknown) {
    if (!isRecord(state) || !isRecord(state.positions) || !Array.isArray(state.edges)
      || !(state.removed === undefined || Array.isArray(state.removed))) {
      warn('state: not a { positions, edges, removed? } object')
      return false
    }
    const removed = new Set(valid(state.removed ?? [], (id): id is string => typeof id === 'string', 'removed ids'))
    const edges = valid(state.edges, isEdge, 'wires')
    const positions = valid(Object.entries(state.positions), (e): e is [string, [number, number]] => isPosition(e[1]), 'positions')

    this.version++
    this.remove(removed)
    for (const [id, n] of this.trash) {
      if (removed.has(id)) continue
      this.trash.delete(id)
      this.nodes.set(id, n)
    }
    for (const [id, [x, y]] of positions) {
      const n = this.nodes.get(id)
      if (n) Object.assign(n, { x, y, placed: true })
    }
    this.edges.clear()
    for (const [from, to] of edges) {
      if (this.canConnect(from, to)) this.connect(from, to)
      else warn(`wire ${from} -> ${to}`)
    }
    return true
  }

  /**
   * Moves nodes to the trash and deletes their wires, in one pass over the wires however many go.
   * @returns the ids that were nodes; unknown ones are skipped.
   */
  remove(ids: Iterable<string>) {
    const gone = new Set<string>()
    for (const id of ids) {
      const n = this.nodes.get(id)
      if (!n) continue
      this.nodes.delete(id)
      this.trash.set(id, n)
      gone.add(id)
    }
    if (!gone.size) return gone
    this.version++
    for (const [key, [from, to]] of this.edges) if (gone.has(nodeOf(from)) || gone.has(nodeOf(to))) this.edges.delete(key)
    return gone
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
