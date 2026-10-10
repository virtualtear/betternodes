import type { Point, Rect } from '../geometry/rect'
import type { WireKey } from '../model/state'
import { h, svg } from './dom'
import { rgba } from './packets/looks'

/** Fixed-size records in one growing byte array, one per key, ready to upload to the GPU as they are. */
export class Slots<K> {
  bytes = new Uint8Array(0)
  floats = new Float32Array(0)
  count = 0
  /** Byte range written since {@link Slots.uploaded}; empty when `lo >= hi`. */
  lo = Infinity
  hi = 0
  private readonly at = new Map<K, number>()
  private readonly keys: K[] = []

  /** @param size - bytes per record, a multiple of 4. */
  constructor(readonly size: number) {}

  /** Byte offset of `key`'s record, added at the end for a new key; marks it written. */
  slot(key: K) {
    let i = this.at.get(key)
    if (i === undefined) {
      if ((this.count + 1) * this.size > this.bytes.length) this.grow()
      i = this.count++
      this.at.set(key, i)
      this.keys[i] = key
    }
    return this.written(i)
  }

  /** Removes `key`'s record; the last record moves into its place, so the records stay packed. */
  delete(key: K) {
    const i = this.at.get(key)
    if (i === undefined) return
    const last = --this.count
    if (i !== last) {
      this.bytes.copyWithin(i * this.size, last * this.size, (last + 1) * this.size)
      this.keys[i] = this.keys[last]
      this.at.set(this.keys[i], i)
      this.written(i)
    }
    this.at.delete(key)
    this.keys.length = last
  }

  /** Marks everything as uploaded. */
  uploaded() {
    this.lo = Infinity
    this.hi = 0
  }

  private written(i: number) {
    const o = i * this.size
    this.lo = Math.min(this.lo, o)
    this.hi = Math.max(this.hi, o + this.size)
    return o
  }

  // Doubles the array; a new array is uploaded whole.
  private grow() {
    const bytes = new Uint8Array(Math.max(4096, this.bytes.length * 2))
    bytes.set(this.bytes)
    this.bytes = bytes
    this.floats = new Float32Array(bytes.buffer)
    this.lo = 0
    this.hi = this.count * this.size
  }
}

// Node vertex: rect as 4 floats, then fill and border as RGBA bytes. Six per node, two triangles.
const NODE_VERTEX = 24
// Wire vertex: point as 2 floats, then stroke as RGBA bytes. Two per segment, five segments.
const WIRE_VERTEX = 12
/** Points of a wire as drawn far out: anchor, stub end, two bends, stub end, anchor. */
export const WIRE_POINTS = 6

/**
 * Every node as a rect and every wire as a line, for drawing far zoom levels on the GPU, where
 * titles are too small to read. Records change only for what changed.
 */
export class Sketch {
  readonly nodes = new Slots<string>(NODE_VERTEX * 6)
  readonly wires = new Slots<WireKey>(WIRE_VERTEX * 2 * (WIRE_POINTS - 1))

  /** Writes node `id`'s record: its rect, fill and border. */
  node(id: string, [x, y, w, h]: Rect, fill: ArrayLike<number>, border: ArrayLike<number>) {
    const { nodes } = this
    const o = nodes.slot(id)
    for (let v = 0; v < 6; v++) {
      const at = o + v * NODE_VERTEX
      const [f, i] = [nodes.floats, at / 4]
      f[i] = x
      f[i + 1] = y
      f[i + 2] = w
      f[i + 3] = h
      nodes.bytes.set(fill, at + 16)
      nodes.bytes.set(border, at + 20)
    }
  }

  /** Writes wire `key`'s record: its {@link WIRE_POINTS} points and its stroke. */
  wire(key: WireKey, points: Point[], stroke: ArrayLike<number>) {
    const { wires } = this
    const o = wires.slot(key)
    for (let s = 0; s < WIRE_POINTS - 1; s++) {
      for (let e = 0; e < 2; e++) {
        const at = o + (2 * s + e) * WIRE_VERTEX
        wires.floats.set(points[s + e], at / 4)
        wires.bytes.set(stroke, at + 8)
      }
    }
  }
}

type Colour = Uint8ClampedArray

/**
 * Node and wire colours as the stylesheet gives them, read from hidden probe elements once per
 * class list, so status classes and themes reach the GPU drawing too.
 */
export class Paints {
  private readonly probes = new Map<string, HTMLElement | SVGGElement>()
  private readonly colours = new Map<string, Colour[]>()
  // The plain node's fill as last read, to notice a theme switch.
  private base = ''

  /**
   * @param nodes - where node probes go: inside the world, so `.bn` rules and variables apply.
   * @param wires - where wire probes go: inside the wire SVG.
   */
  constructor(private readonly nodes: HTMLElement, private readonly wires: SVGElement) {}

  /** Whether the theme changed since the last call; forgets every colour if so. */
  changed() {
    const probe = this.probe('node:', () => h('div', 'bn-node'), this.nodes)
    const base = getComputedStyle(probe).backgroundColor
    if (base === this.base) return false
    this.base = base
    this.colours.clear()
    return true
  }

  /** Fill and border of a node with these extra classes; the border is the accent when selected. */
  node(classes: readonly string[], selected: boolean): Colour[] {
    const key = `node:${classes.join(' ')}`
    let colours = this.colours.get(key + selected)
    if (!colours) {
      // Its text colour stands in for the border variable, which has no colour property of its own.
      const probe = this.probe(key, () => h('div', ['bn-node', ...classes].join(' ')), this.nodes)
      probe.style.color = 'var(--bn-node-border)'
      const s = getComputedStyle(probe)
      colours = [rgba(s.backgroundColor), rgba(selected ? getComputedStyle(this.accent()).color : s.color)]
      this.colours.set(key + selected, colours)
    }
    return colours
  }

  /** Fill and stroke of an element with these classes, e.g. `bn-mini-node error`, and its stroke width. */
  look(className: string): [fill: Colour, stroke: Colour, width: number] {
    const key = `look:${className}`
    let colours = this.colours.get(key)
    if (!colours) {
      const s = getComputedStyle(this.probe(key, () => h('div', className), this.nodes))
      colours = [rgba(s.fill), rgba(s.stroke), new Uint8ClampedArray([parseFloat(s.strokeWidth) || 0])]
      this.colours.set(key, colours)
    }
    return [colours[0], colours[1], colours[2][0]]
  }

  /** Stroke of a wire with these extra classes. */
  wire(classes: readonly string[]): Colour {
    const key = `wire:${classes.join(' ')}`
    let colours = this.colours.get(key)
    if (!colours) {
      const probe = this.probe(key, () => {
        const g = svg('g')
        for (const name of classes) g.classList.add(name)
        g.append(svg('path', 'bn-wire'))
        return g
      }, this.wires)
      colours = [rgba(getComputedStyle(probe.firstElementChild!).stroke)]
      this.colours.set(key, colours)
    }
    return colours[0]
  }

  destroy() {
    for (const probe of this.probes.values()) probe.remove()
  }

  private accent() {
    const probe = this.probe('accent', () => h('div', ''), this.nodes)
    probe.style.color = 'var(--bn-accent)'
    return probe
  }

  private probe<E extends HTMLElement | SVGGElement>(key: string, make: () => E, layer: Element): E {
    let probe = this.probes.get(key) as E | undefined
    if (!probe) {
      probe = layer.appendChild(make())
      probe.style.display = 'none'
      this.probes.set(key, probe)
    }
    return probe
  }
}
