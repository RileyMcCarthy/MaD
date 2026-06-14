import { describe, it, expect } from 'vitest';
import { reorder } from './SortableList';

describe('reorder', () => {
  it('moves an item from one index to another (immutably)', () => {
    const src = ['a', 'b', 'c', 'd'];
    expect(reorder(src, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorder(src, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(src).toEqual(['a', 'b', 'c', 'd']); // original untouched
  });
});
