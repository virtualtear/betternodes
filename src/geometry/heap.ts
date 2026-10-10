/** Binary min-heap of (priority, int value) pairs in typed arrays: no per-entry allocation. */
export class Heap {
  private keys = new Float64Array(256)
  private vals = new Int32Array(256)
  size = 0

  /** Adds `val` with priority `key`; lower keys come out first. */
  push(key: number, val: number) {
    if (this.size === this.keys.length) {
      const [keys, vals] = [new Float64Array(this.size * 2), new Int32Array(this.size * 2)]
      keys.set(this.keys)
      vals.set(this.vals)
      ;[this.keys, this.vals] = [keys, vals]
    }
    let k = this.size++
    for (; k; ) {
      const p = (k - 1) >> 1
      if (this.keys[p] <= key) break
      this.keys[k] = this.keys[p]
      this.vals[k] = this.vals[p]
      k = p
    }
    this.keys[k] = key
    this.vals[k] = val
  }

  /** Removes and returns the value with the lowest priority. */
  pop() {
    const top = this.vals[0]
    const [key, val] = [this.keys[--this.size], this.vals[this.size]]
    let k = 0
    for (;;) {
      let c = 2 * k + 1
      if (c >= this.size) break
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++
      if (key <= this.keys[c]) break
      this.keys[k] = this.keys[c]
      this.vals[k] = this.vals[c]
      k = c
    }
    this.keys[k] = key
    this.vals[k] = val
    return top
  }
}
