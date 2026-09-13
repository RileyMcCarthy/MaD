import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { reorder } from './SortableList';

describe('reorder', () => {
  behaviour(
    {
      id: 'ui.list-reorder-moves-an-item',
      covers: 'src/ui/components/SortableList.tsx#reorder',
      given: 'a four-item list, with the first item dragged to third place and the last item dragged to the front',
      expect: {
        'item-at-target': 'the dragged item lands at its target place',
        'gap-closes': 'the others close the gap',
        'source-untouched': 'the original list is untouched',
      },
    },
    () => {
      const src = ['a', 'b', 'c', 'd'];
      expect(reorder(src, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
      expect(reorder(src, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
      expect(src).toEqual(['a', 'b', 'c', 'd']); // original untouched
    },
  );
});
