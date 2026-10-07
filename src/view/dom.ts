import { ANCHORS } from '../model/graph'

/** `data-*` attributes that tag rendered elements with what they show. */
export type DataKey = 'node' | 'group' | 'wire' | 'anchor'

/** Creates an HTML element with a class and optional plain-text content. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const el = document.createElement(tag)
  el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

/** Creates an SVG element, optionally with a class. */
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, className?: string) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  if (className) el.classList.add(className)
  return el
}

/** The `data-<key>` value of `el` or its closest ancestor that has one. */
export const dataOf = (el: Element, key: DataKey) => el.closest<HTMLElement | SVGElement>(`[data-${key}]`)?.dataset[key]

/** Sets attributes that differ from `values`; rewriting an unchanged one still costs style and layout work. */
export function setAttrs(el: Element, values: Record<string, string | number>) {
  for (const [name, value] of Object.entries(values)) if (el.getAttribute(name) !== `${value}`) el.setAttribute(name, `${value}`)
}

/** Sets inline style properties that differ from `values`. */
export function setStyles(el: HTMLElement | SVGElement, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value)
}

/** Moves a class from one set of elements to another; returns the new holders. */
export function swapClass(cls: string, prev: Element[], next: Element[]) {
  const keep = new Set(next)
  for (const el of prev) if (!keep.has(el)) el.classList.remove(cls)
  // contains() first: per the DOM spec, add() rewrites the class attribute even if nothing changes.
  for (const el of next) if (!el.classList.contains(cls)) el.classList.add(cls)
  return next
}

/** The eight connection point dots of a node, each tagged with its `node.anchor` ref. */
export function anchorDots(node: string) {
  return Object.entries(ANCHORS).map(([name, [fx, fy]]) => {
    const dot = h('span', 'bn-anchor')
    dot.dataset.anchor = `${node}.${name}`
    dot.style.left = `${fx * 100}%`
    dot.style.top = `${fy * 100}%`
    return dot
  })
}

/**
 * `<defs>` with the arrowhead for wire targets; it also fits wire starts (`marker-start`), pointing
 * backwards. Every flow on a page defines the same id; any copy will do.
 */
export function arrowDefs() {
  const defs = svg('defs')
  defs.innerHTML = '<marker id="bn-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse"'
    + ' markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="bn-arrow" d="M0 0L10 5L0 10z"/></marker>'
  return defs
}
