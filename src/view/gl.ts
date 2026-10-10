import { h } from './dom'
import type { Look } from './packets/looks'
import { WIRE_POINTS, type Sketch, type Slots } from './sketch'

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

// Node rects far out: two triangles per node, not instanced, since instancing is slow in software
// renderers. Each of a node's six vertices carries the whole rect; gl_VertexID picks the corner.
const RECT_VERTEX = `#version 300 es
layout(location = 0) in vec4 rect;
layout(location = 1) in vec4 fill;
layout(location = 2) in vec4 border;
uniform vec3 view;
uniform vec2 screen;
uniform float dpr;
out vec2 local;
flat out vec2 size;
flat out vec4 fillColour;
flat out vec4 borderColour;
const vec2 CORNERS[6] = vec2[6](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1), vec2(1, 0), vec2(1, 1));
void main() {
  vec2 corner = CORNERS[gl_VertexID % 6];
  size = rect.zw * view.z * dpr;
  local = corner * size;
  fillColour = fill;
  borderColour = border;
  gl_Position = vec4(((rect.xy + corner * rect.zw) * view.z + view.xy) / screen * vec2(2, -2) + vec2(-1, 1), 0, 1);
}`

// The fill with a one device px border painted over it, as the ring around a node element.
const RECT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 local;
flat in vec2 size;
flat in vec4 fillColour;
flat in vec4 borderColour;
out vec4 colour;
void main() {
  vec4 f = vec4(fillColour.rgb * fillColour.a, fillColour.a);
  vec4 b = vec4(borderColour.rgb * borderColour.a, borderColour.a);
  bool edge = min(min(local.x, local.y), min(size.x - local.x, size.y - local.y)) < 1.0;
  colour = edge ? b + f * (1.0 - b.a) : f;
}`

const LINE_VERTEX = `#version 300 es
layout(location = 0) in vec2 point;
layout(location = 1) in vec4 stroke;
uniform vec3 view;
uniform vec2 screen;
flat out vec4 strokeColour;
void main() {
  strokeColour = stroke;
  gl_Position = vec4((point * view.z + view.xy) / screen * vec2(2, -2) + vec2(-1, 1), 0, 1);
}`

const LINE_FRAGMENT = `#version 300 es
precision mediump float;
flat in vec4 strokeColour;
out vec4 colour;
void main() {
  colour = vec4(strokeColour.rgb * strokeColour.a, strokeColour.a);
}`

interface Program {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  buffer: WebGLBuffer
  uniform: (name: string) => WebGLUniformLocation | null
  // Bytes the buffer holds on the GPU, so a store that grew is uploaded whole.
  bytes: number
}

// A program with its own vertex array and buffer, laid out as `attrs` say.
function build(gl: WebGL2RenderingContext, vertex: string, fragment: string, stride: number, attrs: [size: number, type: GLenum, offset: number][]): Program {
  const program = gl.createProgram()
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
  const vao = gl.createVertexArray()
  const buffer = gl.createBuffer()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  attrs.forEach(([size, type, offset], i) => {
    gl.enableVertexAttribArray(i)
    gl.vertexAttribPointer(i, size, type, type === gl.UNSIGNED_BYTE, stride, offset)
  })
  return { program, vao, buffer, uniform: name => gl.getUniformLocation(program, name), bytes: 0 }
}

/**
 * One WebGL2 canvas that draws every packet dot as a point in a single draw call and, far out, every
 * node and wire of a {@link Sketch} in one more call each.
 * @remarks Points and plain triangles beat instanced quads by far on software renderers such as
 * SwiftShader; on GPUs, points match them.
 */
export class Gl {
  readonly canvas = h('canvas', 'bn-packets')
  private readonly gl: WebGL2RenderingContext
  private readonly dots: Program
  private readonly rects: Program
  private readonly lines: Program
  private bytes = new Uint8Array(0)
  private floats = new Float32Array(0)
  private count = 0

  /** @throws when WebGL2 is missing or the shaders don't build. */
  constructor() {
    const gl = this.canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: true })
    if (!gl) throw new Error('no WebGL2')
    this.gl = gl
    const { FLOAT, UNSIGNED_BYTE } = gl
    this.dots = build(gl, VERTEX, FRAGMENT, STRIDE, [[2, FLOAT, 0], [2, FLOAT, 8], [2, FLOAT, 16], [4, UNSIGNED_BYTE, 24], [4, UNSIGNED_BYTE, 28]])
    this.rects = build(gl, RECT_VERTEX, RECT_FRAGMENT, 24, [[4, FLOAT, 0], [4, UNSIGNED_BYTE, 16], [4, UNSIGNED_BYTE, 20]])
    this.lines = build(gl, LINE_VERTEX, LINE_FRAGMENT, 12, [[2, FLOAT, 0], [4, UNSIGNED_BYTE, 8]])
    gl.useProgram(this.dots.program)
    gl.uniform1f(this.dots.uniform('maxPoint'), gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1])
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
  }

  /** Whether the browser took the context away, e.g. to free GPU memory. */
  get lost() {
    return this.gl.isContextLost()
  }

  /** Starts a frame of up to `capacity` dots. */
  begin(capacity: number) {
    this.count = 0
    if (this.bytes.length >= capacity * STRIDE) return
    this.bytes = new Uint8Array(Math.max(256, capacity * 2) * STRIDE)
    this.floats = new Float32Array(this.bytes.buffer)
  }

  /** Adds a dot at world `x`, `y`; `fade` is its drop progress, 0..1. */
  push(x: number, y: number, { r, width, fill, stroke }: Look, fade: number) {
    const { floats, bytes } = this
    const b = this.count++ * STRIDE
    const f = b / 4
    const e = 1 - (1 - fade) ** 2 // ease-out, close to the CSS one
    floats[f] = x
    floats[f + 1] = y
    floats[f + 2] = r
    floats[f + 3] = width
    floats[f + 4] = 1 - 0.6 * e
    floats[f + 5] = 1 - e
    bytes.set(fill, b + 24)
    bytes.set(stroke, b + 28)
  }

  /**
   * Draws this frame's dots, and the `sketch` if given, for a view panned by `x`, `y` and zoomed by
   * `k`, over a root of `width` x `height` CSS px. Wires go below the dots, nodes above them.
   */
  draw(x: number, y: number, k: number, width: number, height: number, sketch?: Sketch) {
    const { gl, canvas, count } = this
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
    gl.viewport(0, 0, w, h)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const use = (p: Program) => {
      gl.useProgram(p.program)
      gl.bindVertexArray(p.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, p.buffer)
      gl.uniform3f(p.uniform('view'), x + MARGIN, y + MARGIN, k)
      gl.uniform2f(p.uniform('screen'), cw, ch)
      gl.uniform1f(p.uniform('dpr'), dpr)
    }
    if (sketch?.wires.count) {
      use(this.lines)
      this.upload(this.lines, sketch.wires)
      gl.drawArrays(gl.LINES, 0, sketch.wires.count * 2 * (WIRE_POINTS - 1))
    }
    if (count) {
      use(this.dots)
      gl.bufferData(gl.ARRAY_BUFFER, this.bytes, gl.DYNAMIC_DRAW, 0, count * STRIDE)
      gl.drawArrays(gl.POINTS, 0, count)
    }
    if (sketch?.nodes.count) {
      use(this.rects)
      this.upload(this.rects, sketch.nodes)
      gl.drawArrays(gl.TRIANGLES, 0, sketch.nodes.count * 6)
    }
  }

  /** Gives the context back and removes the canvas. */
  release() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
    this.canvas.remove()
  }

  // Sends what changed in `slots` since its last upload, or all of it to a buffer that is too small.
  private upload(p: Program, slots: Slots<unknown>) {
    const { gl } = this
    if (p.bytes !== slots.bytes.length) {
      gl.bufferData(gl.ARRAY_BUFFER, slots.bytes, gl.DYNAMIC_DRAW)
      p.bytes = slots.bytes.length
    } else if (slots.lo < slots.hi) gl.bufferSubData(gl.ARRAY_BUFFER, slots.lo, slots.bytes, slots.lo, slots.hi - slots.lo)
    slots.uploaded()
  }
}
