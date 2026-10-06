import type { Point } from './rect'
import { CLEAR } from './route'

// Gap between neighbouring wires that share a lane, in world px.
const LANE = 6

interface Segment {
  key: string
  // Index of the segment's first point in its wire.
  i: number
  lo: number
  hi: number
}

/**
 * Spreads wire segments that would be drawn on top of each other into side-by-side lanes.
 * @remarks Only middle segments move, so wires still start and end on their anchors, and the whole
 * spread stays inside the clearance band, so no lane touches a node. Returns shifted copies.
 */
export function separate(wires: Map<string, Point[]>) {
  const out = new Map([...wires].map(([key, pts]) => [key, pts.map(p => [...p] as Point)]))
  // Middle segments grouped by the line they run on: `v<x>` for vertical, `h<y>` for horizontal.
  const lines = new Map<string, Segment[]>()
  for (const [key, pts] of wires) {
    for (let i = 1; i < pts.length - 2; i++) {
      const [p, q] = [pts[i], pts[i + 1]]
      const axis = p[0] === q[0] ? 1 : 0 // the coordinate that varies along the segment
      const line = `${axis ? 'v' : 'h'}${p[1 - axis]}`
      const seg = { key, i, lo: Math.min(p[axis], q[axis]), hi: Math.max(p[axis], q[axis]) }
      const segs = lines.get(line)
      if (segs) segs.push(seg)
      else lines.set(line, [seg])
    }
  }
  for (const [line, segs] of lines) {
    if (segs.length < 2) continue
    const across = line[0] === 'v' ? 0 : 1 // the coordinate a lane offset changes
    segs.sort((s, t) => s.lo - t.lo)
    // Walk clusters of segments whose ranges overlap; each cluster becomes a set of lanes.
    for (let i = 0; i < segs.length; ) {
      let [j, hi] = [i + 1, segs[i].hi]
      for (; j < segs.length && segs[j].lo < hi; j++) hi = Math.max(hi, segs[j].hi)
      const lane = segs.slice(i, j).sort((s, t) => (s.key < t.key ? -1 : 1))
      const gap = Math.min(LANE, (2 * (CLEAR - 2)) / Math.max(1, lane.length - 1))
      lane.forEach((seg, k) => {
        const shift = (k - (lane.length - 1) / 2) * gap
        const pts = out.get(seg.key)!
        pts[seg.i][across] += shift
        pts[seg.i + 1][across] += shift
      })
      i = j
    }
  }
  return out
}
