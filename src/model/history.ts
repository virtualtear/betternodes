import type { Point } from '../geometry/rect'
import type { Graph, NodeDef } from './graph'
import type { Diff, Edge, WireKey } from './state'

/** One user edit as it happened: what to undo, what to redo, and the diff the change event reports. */
export interface Step {
  diff: Diff
  /** Where the nodes in `diff.moved` were before the edit. */
  was: Map<string, Point>
}

/**
 * Records one user edit while it happens. The graph reports each wire and node it changes on the
 * edit's behalf; positions are compared when the edit closes.
 * @remarks Only calls made for the edit are recorded, so code that changes the graph during a
 * gesture doesn't end up in the user's undo step.
 */
export class Journal {
  private readonly starts = new Map<string, Point>()
  private readonly added = new Map<WireKey, Edge>()
  private readonly removed = new Map<WireKey, Edge>()
  private readonly trashed = new Set<string>()
  private readonly back = new Set<string>()

  /** Remembers where these nodes are, before the edit moves them. */
  track(nodes: Iterable<NodeDef>) {
    for (const n of nodes) if (!this.starts.has(n.id)) this.starts.set(n.id, [n.x, n.y])
  }

  // A wire removed and added back within one edit, or the other way round, cancels out.
  connected(key: WireKey, edge: Edge) {
    if (!this.removed.delete(key)) this.added.set(key, edge)
  }

  disconnected(key: WireKey, edge: Edge) {
    if (!this.added.delete(key)) this.removed.set(key, edge)
  }

  // Like wires, a node deleted and restored within one edit cancels out.
  deleted(id: string) {
    if (!this.back.delete(id)) this.trashed.add(id)
  }

  restored(id: string) {
    if (!this.trashed.delete(id)) this.back.add(id)
  }

  /** The finished edit; `graph` gives the tracked nodes' positions now. */
  close(graph: Graph): Step {
    const moved: Diff['moved'] = {}
    const was = new Map<string, Point>()
    for (const [id, [x, y]] of this.starts) {
      const n = graph.nodes.get(id)
      if (!n || (n.x === x && n.y === y)) continue
      moved[id] = [n.x, n.y]
      was.set(id, [x, y])
    }
    return {
      diff: {
        added: [...this.added.values()],
        removed: [...this.removed.values()],
        moved,
        nodesRemoved: [...this.trashed],
        nodesRestored: [...this.back],
      },
      was,
    }
  }
}

/** Bounded undo and redo stacks of edits; each step holds only what its edit changed. */
export class History {
  private past: Step[] = []
  private future: Step[] = []

  constructor(private limit = 100) {}

  /** Changes how many edits can be undone; shrinking drops the oldest steps, 0 disables undo. */
  resize(limit: number) {
    this.limit = limit
    this.past.splice(0, this.past.length - limit)
    this.future.splice(0, this.future.length - limit)
  }

  /** Records a new edit; clears the redo stack. */
  push(step: Step) {
    this.past.push(step)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  /** The last edit, moved to the redo stack; undefined without history. */
  undo() {
    const step = this.past.pop()
    if (step) this.future.push(step)
    return step
  }

  /** The last undone edit, moved back to the undo stack; undefined when nothing was undone. */
  redo() {
    const step = this.future.pop()
    if (step) this.past.push(step)
    return step
  }
}
