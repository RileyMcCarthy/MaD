import { ReactNode, useRef, useState, HTMLAttributes } from 'react';

/** Props to spread onto the drag handle element of each row. */
export type DragHandleProps = Pick<HTMLAttributes<HTMLElement>, 'onPointerDown'>;

interface SortableListProps<T> {
  items: T[];
  getKey: (item: T, index: number) => string;
  onReorder: (from: number, to: number) => void;
  renderItem: (item: T, index: number, handle: DragHandleProps) => ReactNode;
}

/**
 * Reorderable list driven by Pointer Events — one code path for mouse, touch
 * and pen (HTML5 drag-and-drop never fires on touch). Only the element given
 * `handle` props starts a drag, so inputs inside rows stay editable; the
 * handle needs `touch-action: none` (see .drag-handle) so a touch drag
 * reorders instead of scrolling the page.
 */
export default function SortableList<T>({
  items,
  getKey,
  onReorder,
  renderItem,
}: SortableListProps<T>) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const rowsRef = useRef<(HTMLDivElement | null)[]>([]);
  const stateRef = useRef<{ drag: number | null; over: number | null }>({ drag: null, over: null });

  if (rowsRef.current.length !== items.length) {
    rowsRef.current.length = items.length;
  }

  /** Row whose vertical midpoint is closest to the pointer. */
  const indexAtY = (y: number): number | null => {
    let best: number | null = null;
    let bestDist = Infinity;
    rowsRef.current.forEach((el, i) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const d = Math.abs(y - (r.top + r.height / 2));
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };

  const startDrag = (index: number) => (e: React.PointerEvent) => {
    // Nested lists (moves inside sets): only the handle actually touched drags.
    e.stopPropagation();
    e.preventDefault();
    stateRef.current = { drag: index, over: index };
    setDragIndex(index);
    setOverIndex(index);

    const onMove = (ev: PointerEvent) => {
      const over = indexAtY(ev.clientY);
      if (over !== null && over !== stateRef.current.over) {
        stateRef.current.over = over;
        setOverIndex(over);
      }
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      const { drag, over } = stateRef.current;
      stateRef.current = { drag: null, over: null };
      setDragIndex(null);
      setOverIndex(null);
      if (drag !== null && over !== null && drag !== over) onReorder(drag, over);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  return (
    <>
      {items.map((item, index) => (
        <div
          key={getKey(item, index)}
          ref={(el) => {
            rowsRef.current[index] = el;
          }}
          className={`sortable-row${
            overIndex === index && dragIndex !== null && dragIndex !== index ? ' drag-over' : ''
          }${dragIndex === index ? ' dragging' : ''}`}
        >
          {renderItem(item, index, { onPointerDown: startDrag(index) })}
        </div>
      ))}
    </>
  );
}

/** Immutable array reorder helper. */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
