import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/useStore';

/**
 * Report an editor's unsaved work to the app, which then asks before the
 * operator leaves the page or closes the tab (App.tsx, useUnsavedGuard).
 * `what` names it for the prompt, e.g. `sample profile "AL-01"`.
 *
 * Returns `confirmDiscard`, for the editor's own actions that would replace
 * its contents (loading another, importing, re-reading): true when there is
 * nothing to lose or the operator agrees to lose it.
 */
export function useUnsavedWork(what: string, unsaved: boolean): { confirmDiscard: () => boolean } {
  const setUnsavedWork = useStore((s) => s.setUnsavedWork);
  useEffect(() => {
    setUnsavedWork(unsaved ? what : null);
  }, [unsaved, what, setUnsavedWork]);
  useEffect(() => () => setUnsavedWork(null), [setUnsavedWork]);
  return {
    confirmDiscard: () => !unsaved || window.confirm(`Your changes to this ${what} are not saved. Discard them?`),
  };
}

/** A save button's brief "Saved ✓": true for a moment after `flash()`. */
export function useSavedFlash(ms = 2500): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const flash = () => {
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), ms);
  };
  return [on, flash];
}
