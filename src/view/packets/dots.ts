import { Gl } from '../gl'
import type { Sketch } from '../sketch'
import { Looks, packetCircle } from './looks'

/** A packet dot; drawn from its first {@link Dots.move} on. */
export interface Dot {
  x: number
  y: number
  className: string
  shown: boolean
  // When a dropped dot started fading out.
  dropped?: number
  // Its circle, when dots are drawn as SVG.
  el?: SVGCircleElement
}

// Matches .bn-drop in style.css, which fades SVG dots.
const FADE = 200
// Without dots for this long, the WebGL context is given back: browsers allow only about 16 per page.
const IDLE = 2000

/**
 * Packet dots, drawn with WebGL above the wires and below the nodes, or as SVG circles where
 * WebGL2 is not available. Their look comes from CSS, see {@link Looks}.
 */
export class Dots {
  private readonly dots = new Set<Dot>()
  private readonly looks: Looks
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)')
  private gl?: Gl
  // WebGL2 failed once; SVG from then on.
  private svgOnly = false
  // Dots were added since the last draw that left the canvas empty: drawing is due even if they are gone.
  private stale = false
  private idle = 0

  /**
   * @param layer - SVG group holding the circles when WebGL is unavailable, and the look probes.
   * @param wires - the wire SVG; the WebGL canvas goes right after it, below the nodes.
   */
  constructor(private readonly layer: SVGGElement, private readonly wires: SVGSVGElement) {
    this.looks = new Looks(layer)
  }

  /** Number of dots still drawn, including fading ones. */
  get size() {
    return this.dots.size
  }

  /** A new dot, hidden until its first move. */
  add(className = '') {
    const dot: Dot = { x: 0, y: 0, className, shown: false }
    this.dots.add(dot)
    this.stale = true
    clearTimeout(this.idle)
    return dot
  }

  move(dot: Dot, x: number, y: number) {
    Object.assign(dot, { x, y, shown: true })
  }

  /** Takes a dot away; with `fade`, as a dropped packet, it shrinks and fades out first. */
  remove(dot: Dot, fade = false) {
    if (!fade || this.reduced.matches) {
      dot.el?.remove()
      this.dots.delete(dot)
    } else if (dot.el) {
      dot.el.classList.add('bn-drop')
      setTimeout(() => dot.el!.remove(), FADE)
      this.dots.delete(dot)
    } else dot.dropped = performance.now()
  }

  /** Whether WebGL2 works here, starting it if needed; the view draws far zoom levels with it. */
  gpu() {
    if (!this.svgOnly && (!this.gl || this.gl.lost)) this.start()
    return !!this.gl
  }

  /**
   * Draws this frame's dots, and the `sketch` of nodes and wires if given, for the given pan, zoom
   * and root size.
   * @returns whether dots are still fading out and need another frame.
   */
  draw(now: number, x: number, y: number, k: number, width: number, height: number, sketch?: Sketch) {
    if (!this.dots.size && !this.stale && !sketch) return false
    if (!this.gpu()) return this.drawSvg()
    const gl = this.gl!
    gl.begin(this.dots.size)
    this.looks.next()
    let fading = false
    for (const dot of this.dots) {
      const fade = dot.dropped === undefined ? 0 : Math.max(0, (now - dot.dropped) / FADE)
      if (fade >= 1) {
        this.dots.delete(dot)
        continue
      }
      if (dot.shown) gl.push(dot.x, dot.y, this.looks.get(dot.className), fade)
      fading ||= dot.dropped !== undefined
    }
    gl.draw(x, y, k, width, height, sketch)
    // A sketch drawn now needs clearing once the view leaves far zoom levels.
    this.stale = this.dots.size > 0 || !!sketch
    if (!this.stale) {
      clearTimeout(this.idle)
      this.idle = setTimeout(() => this.release(), IDLE)
    }
    return fading
  }

  /** Removes every dot and gives back the WebGL context. */
  destroy() {
    for (const dot of this.dots) dot.el?.remove()
    this.dots.clear()
    this.looks.destroy()
    this.release()
  }

  // A new WebGL canvas, replacing one whose context the browser took away.
  private start() {
    this.gl?.release()
    this.gl = undefined
    try {
      this.gl = new Gl()
      this.wires.after(this.gl.canvas)
    } catch {
      this.svgOnly = true
    }
  }

  private release() {
    clearTimeout(this.idle)
    this.gl?.release()
    this.gl = undefined
    this.stale = false
  }

  private drawSvg() {
    this.stale = false
    for (const dot of this.dots) {
      if (!dot.el) {
        dot.el = this.layer.appendChild(packetCircle(dot.className))
        // Without a position it would flash at the world origin for a frame.
        dot.el.setAttribute('visibility', 'hidden')
      }
      if (dot.dropped !== undefined) this.remove(dot, true)
      else if (dot.shown) {
        dot.el.setAttribute('cx', `${dot.x}`)
        dot.el.setAttribute('cy', `${dot.y}`)
        dot.el.removeAttribute('visibility')
      }
    }
    return false
  }
}
