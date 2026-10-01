// Бинарная min-куча для Дейкстры/A*.
// Ключи — числа (стоимость), значения — целые (id вершины).

export class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, val) {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }

  pop() {
    const k = this.keys, v = this.vals;
    if (k.length === 0) return null;
    const topKey = k[0], topVal = v[0];
    if (k.length === 1) {
      k.pop();
      v.pop();
      return { key: topKey, val: topVal };
    }
    const last = k.length - 1;
    k[0] = k[last];
    v[0] = v[last];
    k.pop();
    v.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < k.length && k[l] < k[m]) m = l;
      if (r < k.length && k[r] < k[m]) m = r;
      if (m === i) break;
      [k[m], k[i]] = [k[i], k[m]];
      [v[m], v[i]] = [v[i], v[m]];
      i = m;
    }
    return topVal !== undefined ? { key: topKey, val: topVal } : null;
  }
}
