import { nodeOf, type Graph } from '../../model/graph'
import type { View } from '../view'
import type { Dot } from './dots'

// World px per second.
const SPEED = 240
// Longest frame step in ms: a background tab must not teleport packets.
const MAX_STEP = 100

/** Options for {@link Flow.send}. */
export interface SendOptions {
  /** Extra CSS class on the packet dots, e.g. a status like `'error'`. */
  class?: string
  /**
   * Travel speed in world px per second.
   * @defaultValue 240
   */
  speed?: number
}

// One call to send(): a single packet, or for a flow all copies of it.
interface Send {
  to?: string
  // Flow sends use each wire at most once, which also ends cycles.
  used: Set<string>
  opts: SendOptions
  arrived: string[]
  // Packets still travelling; the send resolves when this reaches 0.
  live: number
  done: (ids: string[]) => void
}

interface Packet {
  send: Send
  wire: string
  // The node it left; where it re-plans from if its wire disappears.
  from: string
  // Progress along the wire's current path, 0..1, so re-routed wires carry the packet along.
  t: number
  dot: Dot
}

/** Packets travelling along wires; advanced once per animation frame while any are in flight. */
export class Packets {
  private readonly live = new Set<Packet>()
  private last = 0
  // Outgoing wires per node, rebuilt only when the graph changes: many packets plan hops per frame.
  private readonly outs = new Map<string, [wire: string, next: string][]>()
  private outsVersion = -1

  constructor(private readonly view: View, private readonly graph: Graph) {
    view.onFrame = now => this.step(now)
  }

  /** Starts a send; resolves with the ids of the nodes its packets arrived at. */
  send(from: string, to: string | undefined, opts: SendOptions) {
    return new Promise<string[]>(done => {
      const send: Send = { to, used: new Set(), opts, arrived: [], live: 1, done } // holds 1 until departure is set up
      this.depart(send, from)
      this.finish(send)
    })
  }

  /** Removes every packet and settles their sends with what arrived so far. */
  clear() {
    for (const p of this.live) {
      this.view.dots.remove(p.dot)
      this.live.delete(p)
      this.finish(p.send)
    }
  }

  // A packet of `send` is at `node`: arrive, or leave along the next wire. `replan` marks a packet
  // that came back because its wire vanished; it doesn't count as reaching an end node.
  private depart(send: Send, node: string, replan = false) {
    if (send.to === undefined) return this.spread(send, node, replan)
    if (node === send.to) {
      send.arrived.push(node)
      return
    }
    const wire = this.hop(node, send.to)
    if (wire) this.launch(send, wire)
  }

  // Flow: one copy per outgoing wire this send hasn't used yet; a node without outgoing wires is an end.
  private spread(send: Send, node: string, replan: boolean) {
    const outs = this.out(node)
    if (!outs.length && !replan) send.arrived.push(node)
    for (const [wire] of outs) {
      if (send.used.has(wire)) continue
      send.used.add(wire)
      this.launch(send, wire)
    }
  }

  private launch(send: Send, wire: string) {
    if (!this.live.size) this.last = performance.now() // first packet after idle: no stale frame delta
    const dot = this.view.dots.add(send.opts.class)
    this.live.add({ send, wire, from: nodeOf(this.graph.edges.get(wire)![0]), t: 0, dot })
    send.live++
    this.view.update()
  }

  // Ends packet `p` at `node` and lets its send carry on from there. A packet that lost its route
  // (nothing carries on, nothing arrived) fades out; a flow copy merging into a node just slips in.
  private moveOn(p: Packet, node: string | undefined, replan: boolean) {
    this.live.delete(p)
    const { send } = p
    const [live, arrived] = [send.live, send.arrived.length]
    if (node !== undefined) this.depart(send, node, replan)
    const stuck = send.live === live && send.arrived.length === arrived
    this.view.dots.remove(p.dot, stuck && (replan || send.to !== undefined))
    this.finish(send)
  }

  private finish(send: Send) {
    if (--send.live === 0) send.done([...new Set(send.arrived)])
  }

  // First wire of a shortest path (fewest hops, along wire direction) from `from` to `to`.
  private hop(from: string, to: string) {
    const first = new Map<string, string>()
    const queue = [from]
    const seen = new Set(queue)
    // An index instead of queue.shift(), which re-indexes the whole array on every call.
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head]
      for (const [wire, next] of this.out(node)) {
        if (seen.has(next)) continue
        seen.add(next)
        first.set(next, first.get(node) ?? wire)
        if (next === to) return first.get(next)
        queue.push(next)
      }
    }
  }

  private out(node: string) {
    if (this.outsVersion !== this.graph.version) {
      this.outs.clear()
      for (const [wire, [a, b]] of this.graph.edges) {
        const list = this.outs.get(nodeOf(a)) ?? []
        list.push([wire, nodeOf(b)])
        this.outs.set(nodeOf(a), list)
      }
      this.outsVersion = this.graph.version
    }
    return this.outs.get(node) ?? []
  }

  private step(now: number) {
    const dt = Math.min(MAX_STEP, now - this.last) / 1000
    this.last = now
    // Packets that reached a node carry on after the loop, so new hops don't join this step.
    const ends: [Packet, string | undefined, boolean][] = []
    for (const p of this.live) {
      const edge = this.graph.edges.get(p.wire)
      if (!edge) {
        // Wire deleted, its end moved, or a node removed: back to the last node, if it still exists.
        ends.push([p, this.graph.nodes.has(p.from) ? p.from : undefined, true])
        continue
      }
      const track = this.view.track(p.wire)
      if (!track) continue // wire not drawn yet
      const { length } = track
      p.t += length ? ((p.send.opts.speed ?? SPEED) * dt) / length : 1
      if (p.t >= 1) ends.push([p, nodeOf(edge[1]), false])
      else this.view.dots.move(p.dot, ...track.at(p.t * length))
    }
    for (const [p, node, replan] of ends) this.moveOn(p, node, replan)
    if (this.live.size) this.view.update()
  }
}
