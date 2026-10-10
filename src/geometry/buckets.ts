import type { Rect } from './rect'

// A private copy of overlap() from ./rect: sharing that one with the router makes it polymorphic in
// V8, which measured about 60% slower in free-spot searches (bench: untangle stacked nodes).
const hit = (a: Rect, b: Rect) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]

// Rects and areas wider or taller than this many cells are not walked cell by cell, so the work per
// call stays bounded however large they are: big rects go to one list checked linearly, big areas
// scan the occupied cells instead.
const REACH = 64
// Beyond this, cell indices lose integer precision and a `cx++` loop would never advance.
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
  private readonly reach: number
  constructor(private size = 256) {
    this.reach = REACH * size
  }

  // Whether `r` can be walked cell by cell. Checked on the raw numbers, before any cell math, and
  // written so NaN and infinite values fail it too.
  private walkable([x, y, w, h]: Rect) {
    return w <= this.reach && h <= this.reach && Math.abs(x) < FAR && Math.abs(y) < FAR
  }

  // Calls `visit` with the key of every cell `r` touches; stops early when `visit` returns false.
  private each([x, y, w, h]: Rect, visit: (key: number) => boolean | void) {
    const [x0, x1, y0, y1] = [Math.floor(x / this.size), Math.floor((x + w) / this.size), Math.floor(y / this.size), Math.floor((y + h) / this.size)]
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) if (visit(cx * 1_000_003 + cy) === false) return false
    }
    return true
  }

  /** Adds `r`, tagged with `value`, e.g. the id of what it belongs to. */
  add(r: Rect, value: T) {
    if (!this.walkable(r)) {
      this.big.rects.push(r)
      this.big.values.push(value)
      return
    }
    this.each(r, key => {
      const cell = this.cells.get(key)
      if (cell) {
        cell.rects.push(r)
        cell.values.push(value)
      } else this.cells.set(key, { rects: [r], values: [value] })
    })
  }

  /** Whether no added rect overlaps `area`. */
  empty(area: Rect) {
    const { rects } = this.big
    for (let i = 0; i < rects.length; i++) if (hit(rects[i], area)) return false
    if (this.walkable(area)) {
      return this.each(area, key => {
        const cell = this.cells.get(key)
        if (cell) for (const r of cell.rects) if (hit(r, area)) return false
      })
    }
    for (const cell of this.cells.values()) for (const r of cell.rects) if (hit(r, area)) return false
    return true
  }

  /** Calls `visit` for every added entry whose rect overlaps `area`; may repeat entries spanning several cells. */
  near(area: Rect, visit: (value: T, r: Rect) => void) {
    // The same loop three times, inlined: a shared closure per call measured slower.
    const { big } = this
    for (let i = 0; i < big.rects.length; i++) if (hit(big.rects[i], area)) visit(big.values[i], big.rects[i])
    if (!this.walkable(area)) {
      for (const cell of this.cells.values()) {
        for (let i = 0; i < cell.rects.length; i++) if (hit(cell.rects[i], area)) visit(cell.values[i], cell.rects[i])
      }
      return
    }
    this.each(area, key => {
      const cell = this.cells.get(key)
      if (!cell) return
      for (let i = 0; i < cell.rects.length; i++) if (hit(cell.rects[i], area)) visit(cell.values[i], cell.rects[i])
    })
  }
}
