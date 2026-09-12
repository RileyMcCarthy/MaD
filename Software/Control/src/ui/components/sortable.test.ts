import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { reorder } from './SortableList';

describe('reorder', () => {
  behaviour(
    {
      id: 'ui.list-reorder-moves-an-item',
      covers: 'src/ui/components/SortableList.tsx#reorder',
      given: 'a four-item list, dragging the first item to the third place and the last item to the first',
      then: 'dragging the first item to the third place puts the first item third, dragging the last item to the front puts the last item first, and the original list is unchanged',
    },
    () => {
      const src = ['a', 'b', 'c', 'd'];
      expect(reorder(src, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
      expect(reorder(src, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
      expect(src).toEqual(['a', 'b', 'c', 'd']); // original untouched
    },
  );
});
