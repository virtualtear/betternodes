import { h } from '../dom'
import type { Look } from './looks'

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

/**
 * One WebGL2 canvas drawing every dot as a point in a single draw call.
 * @remarks Points beat instanced quads by far on software renderers such as SwiftShader, and match
 * them on GPUs.
 */
export class Gl {
  readonly canvas = h('canvas', 'bn-packets')
  private readonly gl: WebGL2RenderingContext
  private readonly uniforms: Record<'view' | 'screen' | 'dpr', WebGLUniformLocation>
  private bytes = new Uint8Array(0)
  private floats = new Float32Array(0)
  private count = 0

  /** @throws when WebGL2 is missing or the shaders don't build. */
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
    this.uniforms = { view: at('view'), screen: at('screen'), dpr: at('dpr') }
    gl.uniform1f(at('maxPoint'), gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1])
    gl.bindVertexArray(gl.createVertexArray())
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    const attrs: [size: number, type: GLenum, offset: number][] = [[2, gl.FLOAT, 0], [2, gl.FLOAT, 8], [2, gl.FLOAT, 16], [4, gl.UNSIGNED_BYTE, 24], [4, gl.UNSIGNED_BYTE, 28]]
    attrs.forEach(([size, type, offset], i) => {
      gl.enableVertexAttribArray(i)
      gl.vertexAttribPointer(i, size, type, type === gl.UNSIGNED_BYTE, STRIDE, offset)
    })
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
  }

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

  /** Draws this frame's dots for a view panned by `x`, `y` and zoomed by `k`, over a root of `width` x `height` CSS px. */
  draw(x: number, y: number, k: number, width: number, height: number) {
    const { gl, canvas, uniforms, count } = this
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
    if (!count) return
    gl.uniform3f(uniforms.view, x + MARGIN, y + MARGIN, k)
    gl.uniform2f(uniforms.screen, cw, ch)
    gl.uniform1f(uniforms.dpr, dpr)
    gl.bufferData(gl.ARRAY_BUFFER, this.bytes, gl.DYNAMIC_DRAW, 0, count * STRIDE)
    gl.drawArrays(gl.POINTS, 0, count)
  }

  release() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
    this.canvas.remove()
  }
}
