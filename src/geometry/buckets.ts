import type { Rect } from './rect'

// A private copy of overlap() from ./rect: sharing that one with the router makes it polymorphic in
// V8, which measured about 60% slower in free-spot searches (bench: untangle stacked nodes).
const hit = (a: Rect, b: Rect) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]

// Cell side in world px.
const CELL = 256
// Rects and areas wider or taller than this many cells are not walked cell by cell, so the work per
// call stays bounded however large they are: big rects go to one list checked linearly, big areas
// scan the occupied cells instead.
const REACH = 64
// Rects with a corner beyond this go to the big list. Below it, cell indices fit in 23 bits each,
// so two of them pack into one exact integer key.
const FAR = 2 ** 30
const SHIFT = FAR / CELL + REACH + 1
const SPAN = 2 * SHIFT + 1

interface Cell<T> {
  // Parallel arrays: plain Rect lists keep the hot `empty` loop free of tuple unpacking.
  rects: Rect[]
  values: T[]
}

// Swap-removes `value` from a cell; false if it isn't there.
function drop<T>(cell: Cell<T>, value: T) {
  const i = cell.values.indexOf(value)
  if (i < 0) return false
  const last = cell.values.length - 1
  cell.rects[i] = cell.rects[last]
  cell.values[i] = cell.values[last]
  cell.rects.pop()
  cell.values.pop()
  return true
}

/**
 * Spatial hash: rects bucketed into coarse square cells, so area queries only look at nearby rects.
 * @remarks Cell keys are numbers, so lookups build no strings: free-spot searches call
 * {@link Buckets.empty} thousands of times. Huge, far-out or non-finite rects work too, just
 * without the speed-up.
 */
export class Buckets<T> {
  private cells = new Map<number, Cell<T>>()
  // Rects too big or too far out for the cells.
  private readonly big: Cell<T> = { rects: [], values: [] }

  // Whether `r` can be walked cell by cell. Checked on the raw numbers, before any cell math, and
  // written so NaN and infinite values fail it too.
  private walkable([x, y, w, h]: Rect) {
    return w <= REACH * CELL && h <= REACH * CELL && Math.abs(x) < FAR && Math.abs(y) < FAR
  }

  // Calls `visit` with the key of every cell `r` touches; stops early when `visit` returns false.
  private each([x, y, w, h]: Rect, visit: (key: number) => boolean | void) {
    const [x0, x1, y0, y1] = [Math.floor(x / CELL), Math.floor((x + w) / CELL), Math.floor(y / CELL), Math.floor((y + h) / CELL)]
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) if (visit((cx + SHIFT) * SPAN + cy + SHIFT) === false) return false
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
    // Loops instead of each(): a closure per call costs more here, where every moved node lands.
    const [x0, x1, y0, y1] = [Math.floor(r[0] / CELL), Math.floor((r[0] + r[2]) / CELL), Math.floor(r[1] / CELL), Math.floor((r[1] + r[3]) / CELL)]
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = (cx + SHIFT) * SPAN + cy + SHIFT
        const cell = this.cells.get(key)
        if (cell) {
          cell.rects.push(r)
          cell.values.push(value)
        } else this.cells.set(key, { rects: [r], values: [value] })
      }
    }
  }

  /** Removes the entry added with `value` at `r`; `r` must equal the rect it was added with. */
  remove(r: Rect, value: T) {
    if (!this.walkable(r)) {
      drop(this.big, value)
      return
    }
    const [x0, x1, y0, y1] = [Math.floor(r[0] / CELL), Math.floor((r[0] + r[2]) / CELL), Math.floor(r[1] / CELL), Math.floor((r[1] + r[3]) / CELL)]
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = (cx + SHIFT) * SPAN + cy + SHIFT
        const cell = this.cells.get(key)
        if (cell && drop(cell, value) && !cell.values.length) this.cells.delete(key)
      }
    }
  }

  /** Moves the entry tagged `value` from rect `from` to `to`; `from` must equal the rect it has. */
  move(from: Rect, to: Rect, value: T) {
    const [x0, x1, y0, y1] = [Math.floor(from[0] / CELL), Math.floor((from[0] + from[2]) / CELL), Math.floor(from[1] / CELL), Math.floor((from[1] + from[3]) / CELL)]
    const same = x0 === Math.floor(to[0] / CELL) && x1 === Math.floor((to[0] + to[2]) / CELL)
      && y0 === Math.floor(to[1] / CELL) && y1 === Math.floor((to[1] + to[3]) / CELL)
    if (!same || !this.walkable(from) || !this.walkable(to)) {
      this.remove(from, value)
      this.add(to, value)
      return
    }
    // Same cells, as for most moves of a drag: swap the rect in place.
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get((cx + SHIFT) * SPAN + cy + SHIFT)!
        cell.rects[cell.values.indexOf(value)] = to
      }
    }
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
