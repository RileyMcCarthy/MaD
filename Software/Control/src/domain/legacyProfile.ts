/**
 * Motion profiles saved in the old format are refused, not reinterpreted.
 *
 * The old format had relative moves (`absoluteOrRelative`, `distance`), and
 * waveforms with cycles, a centre, holds, skew, phase and a triangle shape.
 * The current format has none of these: every move goes to an absolute
 * position, and a waveform runs from rest where the gantry is. Read as the
 * current format, an old profile would silently mean something else (a
 * relative +10 mm move becomes a move to 0 mm), so the app refuses it and
 * says why. Nothing converts it: the profile is rebuilt by hand.
 */

const OLD_MOVE_KEYS = ['absoluteOrRelative'];
const OLD_PARAMETER_KEYS = ['distance', 'cycles', 'dwellHigh', 'dwellLow', 'skew', 'phase', 'centre', 'center', 'circularOffset'];
const WAVEFORMS = new Set(['sine', 'sigmoid', 'chirp']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Why this profile is in the old format, or null when it is in the current one. */
export function legacyProfileProblem(profile: unknown): string | null {
  if (!isRecord(profile) || !Array.isArray(profile.sets)) return null;
  for (const [s, set] of profile.sets.entries()) {
    if (!isRecord(set) || !Array.isArray(set.moves)) continue;
    for (const [m, move] of set.moves.entries()) {
      if (!isRecord(move)) continue;
      const where = `set ${s + 1}, move ${m + 1}`;
      const oldMoveKey = OLD_MOVE_KEYS.find((k) => k in move);
      const params = isRecord(move.moveParameters) ? move.moveParameters : {};
      const oldParamKey = OLD_PARAMETER_KEYS.find((k) => k in params);
      const waveform = params.waveform;
      if (oldMoveKey ?? oldParamKey) {
        return `${where} uses "${oldMoveKey ?? oldParamKey}", from the old motion-profile format. Moves are now absolute positions and waveforms run from rest; rebuild this profile.`;
      }
      if (waveform !== undefined && !WAVEFORMS.has(String(waveform))) {
        return `${where} is a "${String(waveform)}" waveform, which is no longer supported (sine, sigmoid and chirp are); rebuild this profile.`;
      }
    }
  }
  return null;
}
