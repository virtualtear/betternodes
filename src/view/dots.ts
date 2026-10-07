import { h, svg } from './dom'

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
// Bytes per dot: x, y, radius, stroke width, fade scale and alpha as floats, then fill and stroke RGBA.
const STRIDE = 32
// CSS px the canvas reaches past each edge of the root: GPUs may skip a point whose center is off
// the canvas, which would make dots at the edge pop out instead of sliding out.
const MARGIN = 32

// One point sprite per dot, sized in device px. Dots bigger than the GPU's largest point (255px on
// some) shrink to fit instead of being cut off square.
const VERTEX = `#version 300 es
layout(location = 0) in vec2 center;
layout(location = 1) in vec2 size;
layout(location = 2) in vec2 fade;
layout(location = 3) in vec4 fill;
layout(location = 4) in vec4 stroke;
uniform vec3 view;
uniform vec2 screen;
uniform float dpr;
uniform float maxPoint;
flat out vec4 radii;
flat out vec4 fillColour;
flat out vec4 strokeColour;
void main() {
  float px = view.z * fade.x * dpr;
  float outer = (size.x + size.y / 2.0) * px;
  gl_PointSize = min(2.0 * outer + 2.0, maxPoint);
  px *= (gl_PointSize - 2.0) / (2.0 * outer);
  gl_Position = vec4((center * view.z + view.xy) / screen * vec2(2, -2) + vec2(-1, 1), 0, 1);
  radii = vec4((size.x - size.y / 2.0) * px, size.x * px, (size.x + size.y / 2.0) * px, fade.y);
  fillColour = fill;
  strokeColour = stroke;
}`

// A circle with its stroke centred on the edge, painted over the fill as in SVG. Edges are
// antialiased over one device pixel; colours come out premultiplied. Corners of the point are
// discarded, so software renderers skip blending them.
const FRAGMENT = `#version 300 es
precision highp float;
flat in vec4 radii;
flat in vec4 fillColour;
flat in vec4 strokeColour;
out vec4 colour;
void main() {
  float d = length(gl_PointCoord - 0.5) * (2.0 * radii.z + 2.0);
  if (d > radii.z + 0.5) discard;
  float f = clamp(radii.y - d + 0.5, 0.0, 1.0);
  float s = clamp(d - radii.x + 0.5, 0.0, 1.0) * clamp(radii.z - d + 0.5, 0.0, 1.0);
  vec4 fc = vec4(fillColour.rgb, 1) * fillColour.a * f;
  vec4 sc = vec4(strokeColour.rgb, 1) * strokeColour.a * s;
  colour = (sc + fc * (1.0 - sc.a)) * radii.w;
}`

// A dot's look, read from the computed style of a `.bn-packet` circle with its class.
interface Look {
  fill: number[]
  stroke: number[]
  r: number
  width: number
}

// One WebGL2 canvas drawing every dot as a point in a single draw call. Points beat instanced
// quads by far on software renderers such as SwiftShader, and match them on GPUs.
class Gl {
  readonly canvas = h('canvas', 'bn-packets') as HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private uniforms: Record<'view' | 'screen' | 'dpr' | 'maxPoint', WebGLUniformLocation>
  private data = new ArrayBuffer(0)
  private floats = new Float32Array(0)
  private bytes = new Uint8Array(0)

  // Throws when WebGL2 is missing or the shaders don't build; the caller falls back to SVG.
  constructor() {
    const gl = this.canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: true })
    if (!gl) throw new Error('no WebGL2')
    this.gl = gl
    const program = gl.createProgram()
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      gl.attachShader(program, shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
    gl.useProgram(program)
    const at = (name: string) => gl.getUniformLocation(program, name)!
    this.uniforms = { view: at('view'), screen: at('screen'), dpr: at('dpr'), maxPoint: at('maxPoint') }
    gl.uniform1f(this.uniforms.maxPoint, gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1])
    gl.bindVertexArray(gl.createVertexArray())
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    const attrs: [size: number, type: number, offset: number][] = [[2, gl.FLOAT, 0], [2, gl.FLOAT, 8], [2, gl.FLOAT, 16], [4, gl.UNSIGNED_BYTE, 24], [4, gl.UNSIGNED_BYTE, 28]]
    attrs.forEach(([size, type, offset], i) => {
      gl.enableVertexAttribArray(i)
      gl.vertexAttribPointer(i, size, type, type === gl.UNSIGNED_BYTE, STRIDE, offset)
    })
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  get lost() {
    return this.gl.isContextLost()
  }

  /**
   * Draws `dots` with their looks and fade progress for a view panned by `x`, `y` and zoomed by
   * `k`, over a root of `width` x `height` CSS px.
   */
  draw(dots: [Dot, Look, number][], x: number, y: number, k: number, width: number, height: number) {
    const { gl, canvas, uniforms } = this
    const dpr = devicePixelRatio
    const [cw, ch] = [width + 2 * MARGIN, height + 2 * MARGIN]
    const [w, h] = [Math.round(cw * dpr), Math.round(ch * dpr)]
    if (canvas.width !== w || canvas.height !== h) {
      Object.assign(canvas, { width: w, height: h })
      Object.assign(canvas.style, { width: `${cw}px`, height: `${ch}px` })
    }
    // The canvas lives in the world, so nodes cover it; this undoes the world's pan and zoom.
    const transform = `scale(${1 / k}) translate(${-x - MARGIN}px, ${-y - MARGIN}px)`
    if (canvas.style.transform !== transform) canvas.style.transform = transform
    if (this.data.byteLength < dots.length * STRIDE) {
      this.data = new ArrayBuffer(Math.max(256, dots.length * 2) * STRIDE)
      ;[this.floats, this.bytes] = [new Float32Array(this.data), new Uint8Array(this.data)]
    }
    const { floats, bytes } = this
    dots.forEach(([dot, look, fade], i) => {
      const [f, b] = [(i * STRIDE) / 4, i * STRIDE]
      const e = 1 - (1 - fade) ** 2 // ease-out, close to the CSS one
      ;[floats[f], floats[f + 1], floats[f + 2], floats[f + 3], floats[f + 4], floats[f + 5]] = [dot.x, dot.y, look.r, look.width, 1 - 0.6 * e, 1 - e]
      bytes.set(look.fill, b + 24)
      bytes.set(look.stroke, b + 28)
    })
    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.uniform3f(uniforms.view, x + MARGIN, y + MARGIN, k)
    gl.uniform2f(uniforms.screen, cw, ch)
    gl.uniform1f(uniforms.dpr, dpr)
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.data, 0, dots.length * STRIDE), gl.DYNAMIC_DRAW)
    gl.drawArrays(gl.POINTS, 0, dots.length)
  }

  release() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
    this.canvas.remove()
  }
}

/**
 * Packet dots, drawn with WebGL above the wires and below the nodes, or as SVG circles where
 * WebGL2 is not available. Their look comes from CSS: the fill, stroke, stroke-width and r of
 * `.bn-packet` and of the class a packet is sent with.
 */
export class Dots {
  private dots = new Set<Dot>()
  private gl?: Gl
  // WebGL2 failed once; SVG from then on.
  private svgOnly = false
  // Dots were added since the last draw that left the canvas empty: drawing is due even if they are gone.
  private stale = false
  private idle = 0
  // Hidden `.bn-packet` circles, one per class, whose computed style gives the WebGL look.
  private probes = new Map<string, SVGCircleElement>()
  private looks = new Map<string, Look>()
  private reduced = matchMedia('(prefers-reduced-motion: reduce)')
  private paint?: OffscreenCanvasRenderingContext2D

  /**
   * @param layer - SVG group holding the circles when WebGL is unavailable, and the probes.
   * @param wires - the wire SVG; the WebGL canvas goes right after it, below the nodes.
   */
  constructor(private layer: SVGGElement, private wires: SVGSVGElement) {}

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

  /**
   * Draws this frame's dots for the given pan, zoom and root size.
   * @returns whether dots are still fading out and need another frame.
   */
  draw(now: number, x: number, y: number, k: number, width: number, height: number) {
    if (!this.dots.size && !this.stale) return false
    if (!this.svgOnly && (!this.gl || this.gl.lost)) this.start()
    if (!this.gl) return this.drawSvg()
    const list: [Dot, Look, number][] = []
    const looks = new Map<string, Look>()
    let fading = false
    for (const dot of this.dots) {
      const fade = dot.dropped === undefined ? 0 : Math.max(0, (now - dot.dropped) / FADE)
      if (fade >= 1) this.dots.delete(dot)
      else if (dot.shown) {
        let look = looks.get(dot.className)
        if (!look) looks.set(dot.className, (look = this.look(dot.className)))
        list.push([dot, look, fade])
      }
      fading ||= dot.dropped !== undefined && fade < 1
    }
    this.gl.draw(list, x, y, k, width, height)
    this.stale = this.dots.size > 0
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
    for (const probe of this.probes.values()) probe.remove()
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
        dot.el = this.layer.appendChild(svg('circle', 'bn-packet'))
        if (dot.className) dot.el.classList.add(dot.className)
        dot.el.setAttribute('r', '5')
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

  // Read every frame, so theme switches and other style changes reach dots in flight. Parsing is
  // cached per computed value; the reads cost one style recalc the browser would do anyway.
  private look(className: string) {
    let probe = this.probes.get(className)
    if (!probe) {
      probe = this.layer.appendChild(svg('circle', 'bn-packet'))
      if (className) probe.classList.add(className)
      probe.setAttribute('r', '5')
      probe.style.display = 'none'
      this.probes.set(className, probe)
    }
    const s = getComputedStyle(probe)
    const key = `${s.fill}|${s.stroke}|${s.strokeWidth}|${s.r}`
    let look = this.looks.get(key)
    if (!look) {
      const width = parseFloat(s.strokeWidth) || 0
      look = { fill: this.rgba(s.fill), stroke: width ? this.rgba(s.stroke) : [0, 0, 0, 0], r: parseFloat(s.r) || 0, width }
      this.looks.set(key, look)
    }
    return look
  }

  // Any CSS colour as RGBA bytes, by painting one pixel with it; `none` and paint servers come out clear.
  private rgba(colour: string) {
    const g = (this.paint ??= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!)
    g.clearRect(0, 0, 1, 1)
    g.fillStyle = '#0000'
    g.fillStyle = colour
    g.fillRect(0, 0, 1, 1)
    return [...g.getImageData(0, 0, 1, 1).data]
  }
}
