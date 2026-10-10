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
 * spread stays inside the clearance band, so no lane touches a node. Shifted wires come back as
 * copies, all others as the input arrays themselves: neither side may change them in place.
 */
export function separate(wires: Map<string, Point[]>) {
  const out = new Map(wires)
  // Middle segments grouped by the line they run on: horizontal ones by y, vertical ones by x.
  // Number keys, not strings: this runs in every frame that re-routes a wire.
  const lines = [new Map<number, Segment[]>(), new Map<number, Segment[]>()]
  for (const [key, pts] of wires) {
    for (let i = 1; i < pts.length - 2; i++) {
      const [p, q] = [pts[i], pts[i + 1]]
      const axis = p[0] === q[0] ? 1 : 0 // the coordinate that varies along the segment
      const seg = { key, i, lo: Math.min(p[axis], q[axis]), hi: Math.max(p[axis], q[axis]) }
      const segs = lines[axis].get(p[1 - axis])
      if (segs) segs.push(seg)
      else lines[axis].set(p[1 - axis], [seg])
    }
  }
  for (const [axis, byLine] of lines.entries()) {
    const across = 1 - axis // the coordinate a lane offset changes
    for (const segs of byLine.values()) {
      if (segs.length < 2) continue
      segs.sort((s, t) => s.lo - t.lo)
      // Walk clusters of segments whose ranges overlap; each cluster becomes a set of lanes.
      for (let i = 0; i < segs.length; ) {
        let [j, hi] = [i + 1, segs[i].hi]
        for (; j < segs.length && segs[j].lo < hi; j++) hi = Math.max(hi, segs[j].hi)
        if (j - i > 1) spread(segs.slice(i, j), across, wires, out)
        i = j
      }
    }
  }
  return out
}

// Shifts one cluster's segments into evenly spaced lanes, copying a wire before its first shift.
function spread(lane: Segment[], across: number, wires: Map<string, Point[]>, out: Map<string, Point[]>) {
  lane.sort((s, t) => (s.key < t.key ? -1 : 1))
  const gap = Math.min(LANE, (2 * (CLEAR - 2)) / (lane.length - 1))
  lane.forEach((seg, k) => {
    const shift = (k - (lane.length - 1) / 2) * gap
    let pts = out.get(seg.key)!
    if (pts === wires.get(seg.key)) out.set(seg.key, (pts = pts.map((p): Point => [p[0], p[1]])))
    pts[seg.i][across] += shift
    pts[seg.i + 1][across] += shift
  })
}
