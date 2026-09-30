/**
 * Group shields into entities with the common-input-ownership heuristic: transparent addresses spent
 * together in one transaction are controlled by the same party. A service that shields thousands of
 * times from one address is then one member of the crowd, not thousands.
 *
 * Input: each shield's funding addresses. Output: an entity id per shield (0..n-1, dense). Shields
 * without any address get an entity of their own.
 */
export function clusterEntities(addressLists: readonly (readonly string[])[]): number[] {
  const parent: number[] = [];
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const addressNode = new Map<string, number>();
  const shieldNode: number[] = [];
  for (const addresses of addressLists) {
    const node = parent.length;
    parent.push(node);
    shieldNode.push(node);
    for (const address of addresses) {
      let a = addressNode.get(address);
      if (a === undefined) {
        a = parent.length;
        parent.push(a);
        addressNode.set(address, a);
      }
      union(node, a);
    }
  }

  const dense = new Map<number, number>();
  return shieldNode.map((node) => {
    const root = find(node);
    let id = dense.get(root);
    if (id === undefined) {
      id = dense.size;
      dense.set(root, id);
    }
    return id;
  });
}

/**
 * Entities that shielded more than `minShields` times: services, not people. Over a 90-day window the
 * default of 100 means more than one deposit a day, every day; 19 of 26,476 entities in Jul-Sep 2026
 * qualify, and together they made 45% of all shields (docs/methodology.md, section 6.1).
 */
export function serviceEntities(entities: readonly number[], minShields = 100): Set<number> {
  const counts = new Map<number, number>();
  for (const e of entities) counts.set(e, (counts.get(e) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > minShields).map(([e]) => e));
}
