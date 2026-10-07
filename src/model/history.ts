/** Bounded undo/redo stacks of snapshots. */
export class History<T> {
  private past: T[] = []
  private future: T[] = []
  private max: number

  constructor(limit = 100) {
    this.max = limit
  }

  /** How many edits can be undone; shrinking it drops the oldest snapshots, 0 disables undo. */
  get limit() {
    return this.max
  }

  set limit(n: number) {
    this.max = n
    this.past.splice(0, this.past.length - n)
    this.future.splice(0, this.future.length - n)
  }

  /** Records the snapshot from just before a new edit; clears the redo stack. */
  push(before: T) {
    this.past.push(before)
    // ponytail: whole snapshots; store inverse diffs if they get huge.
    if (this.past.length > this.max) this.past.shift()
    this.future = []
  }

  /** Trades the current snapshot `now` for the one before the last edit; undefined without history. */
  undo(now: T) {
    return this.move(this.past, this.future, now)
  }

  /** Trades `now` for the snapshot the last undo left; undefined when nothing was undone. */
  redo(now: T) {
    return this.move(this.future, this.past, now)
  }

  private move(from: T[], to: T[], now: T) {
    const target = from.pop()
    if (target !== undefined) to.push(now)
    return target
  }
}
