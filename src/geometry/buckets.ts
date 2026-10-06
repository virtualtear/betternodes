import type { Rect } from './rect'

// A private copy of overlap() from ./rect: sharing that one with the router makes it polymorphic in
// V8, which measured about 60% slower in free-spot searches (bench: untangle stacked nodes).
const hit = (a: Rect, b: Rect) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]

/**
 * Spatial hash: rects bucketed into coarse square cells, so area queries only look at nearby rects.
 * @remarks Cell keys are numbers and queries allocate nothing, since free-spot searches call
 * {@link Buckets.empty} thousands of times.
 */
export class Buckets<T> {
  // Parallel arrays per cell: plain Rect lists keep the hot `empty` loop free of tuple unpacking.
  private cells = new Map<number, { rects: Rect[]; values: T[] }>()
  constructor(private size = 256) {}

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
    return this.each(area, key => {
      const cell = this.cells.get(key)
      if (cell) for (const r of cell.rects) if (hit(r, area)) return false
    })
  }

  /** Calls `visit` for every added entry whose rect overlaps `area`; may repeat entries spanning several cells. */
  near(area: Rect, visit: (value: T, r: Rect) => void) {
    this.each(area, key => {
      const cell = this.cells.get(key)
      if (!cell) return
      for (let i = 0; i < cell.rects.length; i++) if (hit(cell.rects[i], area)) visit(cell.values[i], cell.rects[i])
    })
  }
}
