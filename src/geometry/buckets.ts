import type { Rect } from './rect'

// A private copy of overlap() from ./rect: sharing that one with the router makes it polymorphic in
// V8, which measured about 60% slower in free-spot searches (bench: untangle stacked nodes).
const hit = (a: Rect, b: Rect) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]

// Rects and areas covering more cells than this are not walked cell by cell, so the work per call
// stays bounded however large they are: big rects go to one list checked linearly, big areas scan
// the occupied cells instead.
const MAX_SPAN = 4096
// Cell indices this far out lose integer precision, so a `cx++` loop would never advance.
const FAR = 2 ** 50

interface Cell<T> {
  // Parallel arrays: plain Rect lists keep the hot `empty` loop free of tuple unpacking.
  rects: Rect[]
  values: T[]
}

/**
 * Spatial hash: rects bucketed into coarse square cells, so area queries only look at nearby rects.
 * @remarks Cell keys are numbers and queries allocate nothing, since free-spot searches call
 * {@link Buckets.empty} thousands of times. Huge, far-out or non-finite rects work too, just
 * without the speed-up.
 */
export class Buckets<T> {
  private cells = new Map<number, Cell<T>>()
  // Rects too big or too far out for the cells.
  private readonly big: Cell<T> = { rects: [], values: [] }
  constructor(private size = 256) {}

  // Calls `visit` with the key of every cell `r` touches, stopping early when it returns false, and
  // returns whether it got through. Visits nothing and returns undefined when `r` covers too many
  // cells or lies too far out.
  private each([x, y, w, h]: Rect, visit: (key: number) => boolean | void) {
    const [x0, x1, y0, y1] = [Math.floor(x / this.size), Math.floor((x + w) / this.size), Math.floor(y / this.size), Math.floor((y + h) / this.size)]
    // Negated, so NaN and infinite coordinates end up here too.
    if (!((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_SPAN && Math.max(-x0, x1, -y0, y1) < FAR)) return undefined
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) if (visit(cx * 1_000_003 + cy) === false) return false
    }
    return true
  }

  /** Adds `r`, tagged with `value`, e.g. the id of what it belongs to. */
  add(r: Rect, value: T) {
    const walked = this.each(r, key => {
      const cell = this.cells.get(key)
      if (cell) {
        cell.rects.push(r)
        cell.values.push(value)
      } else this.cells.set(key, { rects: [r], values: [value] })
    })
    if (walked === undefined) {
      this.big.rects.push(r)
      this.big.values.push(value)
    }
  }

  /** Whether no added rect overlaps `area`. */
  empty(area: Rect) {
    for (const r of this.big.rects) if (hit(r, area)) return false
    const walked = this.each(area, key => {
      const cell = this.cells.get(key)
      if (cell) for (const r of cell.rects) if (hit(r, area)) return false
    })
    if (walked !== undefined) return walked
    for (const cell of this.cells.values()) for (const r of cell.rects) if (hit(r, area)) return false
    return true
  }

  /** Calls `visit` for every added entry whose rect overlaps `area`; may repeat entries spanning several cells. */
  near(area: Rect, visit: (value: T, r: Rect) => void) {
    const scan = (cell: Cell<T>) => {
      for (let i = 0; i < cell.rects.length; i++) if (hit(cell.rects[i], area)) visit(cell.values[i], cell.rects[i])
    }
    scan(this.big)
    const walked = this.each(area, key => {
      const cell = this.cells.get(key)
      if (cell) scan(cell)
    })
    if (walked === undefined) for (const cell of this.cells.values()) scan(cell)
  }
}
