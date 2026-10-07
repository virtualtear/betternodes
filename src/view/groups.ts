import type { Rect } from '../geometry/rect'
import type { Graph } from '../model/graph'
import { h, setStyles } from './dom'

/** Group frames, inserted before `layer` so they sit behind wires and nodes. */
export class Groups {
  private readonly els = new Map<string, HTMLElement>()

  constructor(private readonly graph: Graph, private readonly layer: Element) {}

  /** Syncs frames with the graph's groups; frames without a rect in `frames` hide. */
  render(frames: Map<string, Rect>) {
    for (const [id, el] of this.els) {
      if (this.graph.groups.has(id)) continue
      el.remove()
      this.els.delete(id)
    }
    // Runs on every drag frame, so only real changes are written.
    for (const { id, title, classes = [] } of this.graph.groups.values()) {
      const el = this.els.get(id) ?? this.create(id)
      const className = ['bn-group', ...classes].join(' ')
      if (el.className !== className) el.className = className
      const label = el.firstChild!
      if (label.textContent !== title) label.textContent = title
      const frame = frames.get(id)
      if (!frame) {
        setStyles(el, { display: 'none' })
        continue
      }
      const [x, y, width, height] = frame
      setStyles(el, { display: '', transform: `translate(${x}px, ${y}px)`, width: `${width}px`, height: `${height}px` })
    }
  }

  private create(id: string) {
    const el = h('div', '')
    el.dataset.group = id
    el.append(h('div', 'bn-group-title'))
    this.els.set(id, el)
    this.layer.before(el)
    return el
  }
}
