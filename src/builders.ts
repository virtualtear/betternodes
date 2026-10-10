import { fail } from './check'
import { WORLD } from './geometry/rect'
import type { Graph, GroupDef, NodeDef } from './model/graph'
import type { View } from './view/view'

/** Fluent handle for defining one node. */
export class NodeBuilder {
  constructor(private readonly def: NodeDef, private readonly view: View) {}

  /** Sets the node's title text. */
  title(text: string) {
    return this.set({ title: text })
  }

  /**
   * Places the node's top-left corner at world coordinates.
   * @throws if a coordinate is not a number within ±10,000,000.
   */
  at(x: number, y: number) {
    if (!(Math.abs(x) <= WORLD && Math.abs(y) <= WORLD)) fail(`position ${x}, ${y} is not within ±${WORLD}`)
    return this.set({ x, y, placed: true }, 'place')
  }

  /** Sets extra CSS classes on the node, replacing earlier ones; e.g. a status like `'error'`. */
  class(...names: string[]) {
    return this.set({ classes: names }, 'place')
  }

  /** Mounts custom markup below the title; render it with any framework. */
  content(el: HTMLElement) {
    return this.set({ content: el })
  }

  private set(patch: Partial<NodeDef>, update: 'mark' | 'place' = 'mark') {
    Object.assign(this.def, patch)
    this.view[update](this.def.id)
    return this
  }
}

/** Fluent handle for defining one group: a titled frame drawn around its member nodes. */
export class GroupBuilder {
  constructor(private readonly def: GroupDef, private readonly graph: Graph, private readonly view: View) {}

  /** Sets the frame's title text. */
  title(text: string) {
    return this.set({ title: text })
  }

  /** Sets extra CSS classes on the frame, replacing earlier ones. */
  class(...names: string[]) {
    return this.set({ classes: names })
  }

  /**
   * Makes these nodes the members, replacing earlier ones. A node is in at most one group, so this
   * takes it out of any other.
   * @remarks Ids of nodes not defined yet, or deleted by the user, are fine: the frame shows
   * whichever members exist, and hides while there are none.
   */
  nodes(...ids: string[]) {
    this.graph.setMembers(this.def.id, ids)
    this.view.markGroups()
    return this
  }

  private set(patch: Partial<GroupDef>) {
    Object.assign(this.def, patch)
    this.view.markGroups()
    return this
  }
}
