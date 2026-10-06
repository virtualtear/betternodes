import { ANCHORS } from '../model/graph'

/** Creates an HTML element with a class and optional plain-text content. */
export function h(tag: string, className: string, text?: string) {
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

/** Moves a class from one set of elements to another; returns the new holders. */
export function swapClass(cls: string, prev: Element[], next: Element[]) {
  // A Set, so large selections stay linear instead of prev x next.
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

/** `<defs>` with the arrowhead for wire targets. Every flow on a page defines the same id; any copy will do. */
export function arrowDefs() {
  const defs = svg('defs')
  defs.innerHTML = '<marker id="bn-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse"'
    + ' markerWidth="10" markerHeight="10" orient="auto"><path class="bn-arrow" d="M0 0L10 5L0 10z"/></marker>'
  return defs
}
