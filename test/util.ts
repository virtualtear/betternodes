import { onTestFinished } from 'vitest'
import '../src/style.css'

type Point = { x: number; y: number }

/** Resolves after the next animation frame, once batched renders have flushed. */
export const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()))

/** Screen-space center of an element. */
export function center(el: Element): Point {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/** Creates a fixed-size container in the page and removes it after the test. */
export function container(): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px'
  document.body.append(el)
  onTestFinished(() => el.remove())
  return el
}

/**
 * Dispatches one synthetic mouse pointer event at an element's center or a screen point.
 * Like a real browser, the event targets whatever element is under that point. `mods` adds e.g. `shiftKey`.
 */
export function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', at: Element | Point, mods: PointerEventInit = {}) {
  const p = at instanceof Element ? center(at) : at
  const target = document.elementFromPoint(p.x, p.y) ?? document.body
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, clientX: p.x, clientY: p.y, pointerId: 1, isPrimary: true, pointerType: 'mouse',
    button: 0, buttons: type === 'pointerup' ? 0 : 1, ...mods,
  }))
}

/** Drags between element centers or screen points, then waits for the render. */
export async function drag(from: Element | Point, to: Element | Point, mods: PointerEventInit = {}) {
  pointer('pointerdown', from, mods)
  pointer('pointermove', to)
  pointer('pointerup', to)
  await frame()
}

/** Screen point on wire `key`, `px` along it from its `from` or `to` end. */
export function wirePoint(el: HTMLElement, key: string, end: 'from' | 'to', px = 20): Point {
  const path = el.querySelector<SVGPathElement>(`[data-wire="${key}"] .bn-wire`)!
  const len = end === 'from' ? px : path.getTotalLength() - px
  const p = path.getPointAtLength(len).matrixTransform(path.getScreenCTM()!)
  return { x: p.x, y: p.y }
}

/** Presses and releases the pointer at one spot, then waits for the render. */
export async function click(at: Element | Point, mods: PointerEventInit = {}) {
  pointer('pointerdown', at, mods)
  pointer('pointerup', at, mods)
  await frame()
}

/** Dispatches a key press on `el`; in a real browser a click inside the graph focuses its root. */
export function press(el: Element, key: string, mods: KeyboardEventInit = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }))
}
