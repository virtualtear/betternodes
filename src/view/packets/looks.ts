import { svg } from '../dom'

/** A dot's look: fill and stroke as RGBA bytes, radius and stroke width in world px. */
export interface Look {
  fill: ArrayLike<number>
  stroke: ArrayLike<number>
  r: number
  width: number
}

const CLEAR = [0, 0, 0, 0]

let paint: OffscreenCanvasRenderingContext2D | undefined

/** Any CSS colour as RGBA bytes, by painting one pixel with it; `none` and paint servers come out clear. */
export function rgba(colour: string) {
  const g = (paint ??= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!)
  g.clearRect(0, 0, 1, 1)
  g.fillStyle = '#0000'
  g.fillStyle = colour
  g.fillRect(0, 0, 1, 1)
  return g.getImageData(0, 0, 1, 1).data
}

/** An SVG packet circle with the extra class `className`. */
export function packetCircle(className: string) {
  const el = svg('circle', 'bn-packet')
  if (className) el.classList.add(className)
  el.setAttribute('r', '5')
  return el
}

/**
 * Packet looks from CSS: the fill, stroke, stroke-width and r of `.bn-packet` with each class,
 * read from hidden probe circles.
 */
export class Looks {
  private readonly probes = new Map<string, SVGCircleElement>()
  // Parsed looks by computed style, and this frame's looks by class.
  private readonly parsed = new Map<string, Look>()
  private readonly current = new Map<string, Look>()

  constructor(private readonly layer: SVGGElement) {}

  /** Starts a new frame: styles are read again, so theme switches reach dots in flight. */
  next() {
    this.current.clear()
  }

  /** The look of a dot with this class, read at most once per frame. */
  get(className: string) {
    let look = this.current.get(className)
    if (!look) this.current.set(className, (look = this.read(className)))
    return look
  }

  destroy() {
    for (const probe of this.probes.values()) probe.remove()
  }

  // The reads cost one style recalc the browser would do anyway; parsing is cached per computed value.
  private read(className: string) {
    let probe = this.probes.get(className)
    if (!probe) {
      probe = this.layer.appendChild(packetCircle(className))
      probe.style.display = 'none'
      this.probes.set(className, probe)
    }
    const s = getComputedStyle(probe)
    const key = `${s.fill}|${s.stroke}|${s.strokeWidth}|${s.r}`
    let look = this.parsed.get(key)
    if (!look) {
      const width = parseFloat(s.strokeWidth) || 0
      look = { fill: rgba(s.fill), stroke: width ? rgba(s.stroke) : CLEAR, r: parseFloat(s.r) || 0, width }
      this.parsed.set(key, look)
    }
    return look
  }
}
