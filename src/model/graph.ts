import { WORLD } from '../geometry/rect'
import type { Journal } from './history'
import { wireKey, type Edge, type State, type WireKey } from './state'

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
  /** Order of definition: of two overlapping nodes, the later one moves. */
  seq: number
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
  // Not split(), which builds an array per call: removals, layout and packet hops run this per wire.
  const dot = ref.indexOf('.')
  return dot < 0 ? ref : ref.slice(0, dot)
}

/** Anchor name of a `'nodeId.anchor'` ref. */
export const anchorOf = (ref: string) => ref.slice(ref.indexOf('.') + 1) as Anchor

const NONE: ReadonlySet<never> = new Set()

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
  readonly edges = new Map<WireKey, Edge>()
  /** Deleted nodes, kept so undo or `load()` can bring them back. */
  readonly trash = new Map<string, NodeDef>()
  /** Wire notes by wire key; they outlive their wire, so a wire brought back gets its note back. */
  readonly labels = new Map<WireKey, string>()
  /** Extra CSS classes by wire key; they outlive their wire like notes. */
  readonly classes = new Map<WireKey, string[]>()
  readonly groups = new Map<string, GroupDef>()
  /** Group id per node id, so a node is in at most one group. Kept for deleted nodes too. */
  readonly memberOf = new Map<string, string>()
  /** Keys of wires added, deleted, noted or classed since the view last took them. */
  readonly dirty = new Set<WireKey>()
  // The wires at each node, in or out, so a node's wires are found without walking all of them.
  private readonly at = new Map<string, Set<WireKey>>()
  // Member ids per group, the reverse of memberOf.
  private readonly held = new Map<string, Set<string>>()
  private seq = 0

  /** Defines node `id` at the origin, ranked after every node defined before it. */
  add(id: string) {
    const def: NodeDef = { id, title: id, x: 0, y: 0, seq: this.seq++ }
    this.nodes.set(id, def)
    return def
  }

  /** Keys of the wires that start or end at node `id`. */
  wiresAt(id: string): ReadonlySet<WireKey> {
    return this.at.get(id) ?? NONE
  }

  /** True if both refs name existing anchors or nodes, on different nodes, and the wire is new. */
  canConnect(from: string, to: string) {
    return this.has(from) && this.has(to) && nodeOf(from) !== nodeOf(to) && !this.edges.has(wireKey(from, to))
  }

  /**
   * Adds a wire, recording it in `journal` if given.
   * @throws if {@link Graph.canConnect} rejects the wire.
   */
  connect(from: string, to: string, journal?: Journal) {
    if (!this.canConnect(from, to)) throw new Error(`betternodes: invalid wire ${from} -> ${to}`)
    const key = wireKey(from, to)
    const edge: Edge = [from, to]
    this.edges.set(key, edge)
    this.link(nodeOf(from), key)
    this.link(nodeOf(to), key)
    this.dirty.add(key)
    journal?.connected(key, edge)
  }

  /**
   * Deletes a wire, recording it in `journal` if given.
   * @returns false if there was no such wire.
   */
  disconnect(from: string, to: string, journal?: Journal) {
    const key = wireKey(from, to)
    const edge = this.edges.get(key)
    if (!edge) return false
    this.unlink(key)
    journal?.disconnected(key, edge)
    return true
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

    this.remove(removed)
    this.restore([...this.trash.keys()].filter(id => !removed.has(id)))
    for (const [id, [x, y]] of positions) {
      const n = this.nodes.get(id)
      if (n) Object.assign(n, { x, y, placed: true })
    }
    for (const key of this.edges.keys()) this.dirty.add(key)
    this.edges.clear()
    this.at.clear()
    for (const [from, to] of edges) {
      if (this.canConnect(from, to)) this.connect(from, to)
      else warn(`wire ${from} -> ${to}`)
    }
    return true
  }

  /**
   * Moves nodes to the trash and deletes their wires, recording both in `journal` if given.
   * @returns the ids that were nodes; unknown ones are skipped.
   */
  remove(ids: Iterable<string>, journal?: Journal) {
    const gone = new Set<string>()
    for (const id of ids) {
      const n = this.nodes.get(id)
      if (!n) continue
      this.nodes.delete(id)
      this.trash.set(id, n)
      gone.add(id)
      journal?.deleted(id)
    }
    // Only far ends that stay need their sets updated: a removed node's whole set goes.
    for (const id of gone) {
      for (const key of this.wiresAt(id)) {
        const edge = this.edges.get(key)
        if (!edge) continue // deleted from its other end already
        this.edges.delete(key)
        this.dirty.add(key)
        journal?.disconnected(key, edge)
        const far = nodeOf(edge[0]) === id ? nodeOf(edge[1]) : nodeOf(edge[0])
        if (!gone.has(far)) this.at.get(far)?.delete(key)
      }
      this.at.delete(id)
    }
    return gone
  }

  /**
   * Brings deleted nodes back from the trash, without their wires; records them in `journal` if given.
   * @returns the ids that were in the trash.
   */
  restore(ids: Iterable<string>, journal?: Journal) {
    const back = new Set<string>()
    for (const id of ids) {
      const n = this.trash.get(id)
      if (!n) continue
      this.trash.delete(id)
      this.nodes.set(id, n)
      back.add(id)
      journal?.restored(id)
    }
    return back
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
    for (const id of this.held.get(group) ?? []) this.memberOf.delete(id)
    this.held.delete(group)
    for (const id of ids) {
      const old = this.memberOf.get(id)
      if (old !== undefined) this.held.get(old)?.delete(id)
      this.memberOf.set(id, group)
    }
    if (ids.length) this.held.set(group, new Set(ids))
  }

  /** Ids of the shown members of `group`. */
  membersOf(group: string) {
    return [...this.held.get(group) ?? []].filter(id => this.nodes.has(id))
  }

  /** Member ids of every group that has members shown. */
  members() {
    const out = new Map<string, string[]>()
    for (const group of this.held.keys()) {
      const ids = this.membersOf(group)
      if (ids.length) out.set(group, ids)
    }
    return out
  }

  /** The editor state: positions of the shown nodes, every wire, and the deleted node ids if any. */
  toState(): State {
    const positions: State['positions'] = {}
    for (const n of this.nodes.values()) positions[n.id] = [n.x, n.y]
    const state: State = { positions, edges: [...this.edges.values()].map(([from, to]) => [from, to]) }
    if (this.trash.size) state.removed = [...this.trash.keys()]
    return state
  }

  private link(id: string, key: WireKey) {
    const keys = this.at.get(id)
    if (keys) keys.add(key)
    else this.at.set(id, new Set([key]))
  }

  private unlink(key: WireKey) {
    const edge = this.edges.get(key)
    if (!edge) return false
    this.edges.delete(key)
    this.dirty.add(key)
    this.at.get(nodeOf(edge[0]))?.delete(key)
    this.at.get(nodeOf(edge[1]))?.delete(key)
    return true
  }

  // A bare node id is a valid ref too: the view picks its anchor per render.
  private has(ref: string) {
    return this.nodes.has(nodeOf(ref)) && (!ref.includes('.') || isAnchor(anchorOf(ref)))
  }

  private patch<V>(map: Map<WireKey, V>, key: WireKey, value: V | undefined) {
    if (value === undefined) map.delete(key)
    else map.set(key, value)
    this.dirty.add(key)
  }
}
