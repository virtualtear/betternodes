import type { View } from '../view'

type Handler = (e: PointerEvent) => void

// Screen px inside the root's border where a drag pans the view, and the pan speed at the border
// itself in px per ms.
const EDGE = 40
const EDGE_SPEED = 0.6
// Pointer travel in screen px below which a press counts as a click.
const SLOP = 4

/** Whether `up` released the press `down` without moving it far: a click, not a drag. */
export const isClick = (down: PointerEvent, up: PointerEvent) =>
  up.type === 'pointerup' && Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) < SLOP

/**
 * Follows one pointer gesture on window, so moves and the drop register wherever the pointer goes.
 * @remarks `end` also runs on pointercancel. Aborting `signal` drops the gesture without calling
 * `end`. With `view`, holding the pointer near the root's border pans it.
 */
// Avoids setPointerCapture, which would retarget pointerup to the drag source.
export function gesture(move: Handler, end: Handler, signal: AbortSignal, view?: View) {
  const own = new AbortController()
  const opts = { signal: AbortSignal.any([signal, own.signal]) }
  const done = (e: PointerEvent) => {
    own.abort()
    end(e)
  }
  addEventListener('pointermove', view ? edgePan(view, move, opts.signal) : move, opts)
  addEventListener('pointerup', done, opts)
  addEventListener('pointercancel', done, opts)
}

// While the pointer is near the root's border, pans every frame and replays the last move, so
// whatever is dragged follows. Runs no frames anywhere else.
function edgePan(view: View, move: Handler, signal: AbortSignal): Handler {
  // Read once: the root stays put during a drag, and a read per frame could force a layout.
  const r = view.root.getBoundingClientRect()
  // Faster the deeper into the zone, full speed beyond the border.
  const speed = (p: number, lo: number, hi: number) =>
    p < lo + EDGE ? -Math.min(1, (lo + EDGE - p) / EDGE) * EDGE_SPEED
    : p > hi - EDGE ? Math.min(1, (p - hi + EDGE) / EDGE) * EDGE_SPEED : 0
  const velocity = (e: PointerEvent) => [speed(e.clientX, r.left, r.right), speed(e.clientY, r.top, r.bottom)]
  let last: PointerEvent
  let frame = 0
  let then = 0
  const tick = (now: number) => {
    const [vx, vy] = velocity(last)
    if (!vx && !vy) {
      frame = 0
      return
    }
    // Requested before the writes below schedule the view's frame, so this tick runs first in each
    // frame and its toWorld() reads come before the view's DOM writes.
    frame = requestAnimationFrame(tick)
    // Time-based, so the speed doesn't depend on the display rate. Capped after a tab switch.
    const dt = Math.min(50, Math.max(0, now - then))
    then = now
    view.viewport(view.x - vx * dt, view.y - vy * dt, view.k)
    move(last)
  }
  signal.addEventListener('abort', () => cancelAnimationFrame(frame))
  return e => {
    last = e
    move(e)
    if (frame || !velocity(e).some(Boolean)) return
    then = performance.now()
    frame = requestAnimationFrame(tick)
  }
}
