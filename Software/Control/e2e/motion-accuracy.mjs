/**
 * 1 µm motion-accuracy checks for recorded runs.
 *
 * A single time delay (or phase delay) absorbs MONITOR-vs-MOTOR skew and,
 * during cruise, the plant's first-order lag. A wrong rate or a warped shape
 * cannot hide behind that delay: it grows with travel.
 *
 * Two contracts:
 *   - arrival (0.001 mm): at rest, the commanded profile and the gantry sit
 *     on the target. This is the 1 µm position claim.
 *   - follow (after delay): on cruise the commanded profile stays within one
 *     control tick of travel of the trapezoid. The profiler is a 1 kHz
 *     staircase of v micrometres per tick; MONITOR samples it from another
 *     cog, so L∞ cannot beat that step. A wrong rate still fails: it grows
 *     with travel and misses the 1 µm arrival.
 *
 * Encoder-while-moving is a different claim. The SIL plant (SERVO_LOAD_LOSS and
 * SERVO_TAU_S in MaDSim/src/wiring.rs) is a first-order lag, not a pure delay:
 * a sine's amplitude droops, and accel corners leave a residual a delay cannot
 * absorb. Firmware unit tests prove encoder tracking against an ideal plant.
 * Here, encoder follow is asserted only on linear cruise after the lag has
 * settled into a delay.
 */

export const CONTRACT_UM = 1;

/** Shipped machine acceleration (dev_nvram_config.c). */
export const SHIPPED_ACCEL_MM_S2 = 600;

/** SIL first-order velocity lag (SERVO_TAU_S). Five time-constants of cruise
 *  still leave ~1.3 µm of exponential residual at 10 mm/s; seven (~140 ms)
 *  leave ~0.2 µm. */
const PLANT_SETTLE_S = 0.15;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function say(log, line) {
  if (log) log(line);
  else console.log(line);
}

/** Closed-form trapezoid displacement (same kinematics as test_dev_servo). */
export function trapezoidTravelUm(distUm, vUmS, aUmS2, tS) {
  const D = Math.abs(distUm);
  const sign = distUm >= 0 ? 1 : -1;
  if (D <= 0 || vUmS <= 0 || aUmS2 <= 0 || tS <= 0) return 0;
  const sAcc = (vUmS * vUmS) / (2 * aUmS2);
  if (2 * sAcc >= D) {
    const vPeak = Math.sqrt(aUmS2 * D);
    const tAcc = vPeak / aUmS2;
    const tTotal = 2 * tAcc;
    if (tS >= tTotal) return distUm;
    if (tS <= tAcc) return sign * 0.5 * aUmS2 * tS * tS;
    const td = tTotal - tS;
    return sign * (D - 0.5 * aUmS2 * td * td);
  }
  const tAcc = vUmS / aUmS2;
  const tCruise = (D - 2 * sAcc) / vUmS;
  const tTotal = 2 * tAcc + tCruise;
  if (tS >= tTotal) return distUm;
  if (tS <= tAcc) return sign * 0.5 * aUmS2 * tS * tS;
  if (tS <= tAcc + tCruise) return sign * (sAcc + vUmS * (tS - tAcc));
  const td = tTotal - tS;
  return sign * (D - 0.5 * aUmS2 * td * td);
}

export function trapezoidTimes(distUm, vUmS, aUmS2) {
  const D = Math.abs(distUm);
  const sAcc = (vUmS * vUmS) / (2 * aUmS2);
  if (2 * sAcc >= D) {
    const tAcc = Math.sqrt(D / aUmS2);
    return { tAcc, tCruise: 0, tBrake: tAcc, tTotal: 2 * tAcc, sAcc: D / 2, triangular: true };
  }
  const tAcc = vUmS / aUmS2;
  const tCruise = (D - 2 * sAcc) / vUmS;
  return { tAcc, tCruise, tBrake: tAcc + tCruise, tTotal: 2 * tAcc + tCruise, sAcc, triangular: false };
}

/**
 * Align `measuredUm` to `idealAtSec(t)` with a single time delay, then report
 * the worst residual. Evaluates at the recorded sample times — interpolating
 * a 100 Hz accel parabola onto a finer grid is itself several micrometres.
 */
export function fitDelayMaxError(timesUs, measuredUm, idealAtSec, {
  delayMinS = -0.05,
  delayMaxS = 0.05,
  tMinS = -Infinity,
  tMaxS = Infinity,
} = {}) {
  const evalDelay = (delayS) => {
    let sumSq = 0;
    let worst = 0;
    let n = 0;
    let atT = 0;
    let atM = 0;
    let atI = 0;
    const nSamp = Math.min(timesUs.length, measuredUm.length);
    for (let i = 0; i < nSamp; i++) {
      const t = timesUs[i] / 1e6;
      if (t < tMinS || t > tMaxS) continue;
      const m = measuredUm[i];
      if (!Number.isFinite(m)) continue;
      const ideal = idealAtSec(t - delayS);
      if (ideal == null || !Number.isFinite(ideal)) continue;
      const e = m - ideal;
      const ae = Math.abs(e);
      if (ae > worst) {
        worst = ae;
        atT = t;
        atM = m;
        atI = ideal;
      }
      sumSq += e * e;
      n += 1;
    }
    return { worst, rms: n ? Math.sqrt(sumSq / n) : Infinity, n, atT, atM, atI, delayS };
  };

  let best = evalDelay(0);
  // Coarse: RMS finds the delay basin (robust to a single spike).
  for (let d = delayMinS; d <= delayMaxS + 1e-15; d += 0.001) {
    const got = evalDelay(d);
    if (got.n > 10 && got.rms < best.rms) best = got;
  }
  // Fine: the contract is L∞, so polish against worst residual.
  const lo = Math.max(delayMinS, best.delayS - 0.002);
  const hi = Math.min(delayMaxS, best.delayS + 0.002);
  for (let d = lo; d <= hi + 1e-12; d += 0.00001) {
    const got = evalDelay(d);
    if (got.n > 10 && got.worst < best.worst - 1e-9) best = got;
  }
  return best;
}

export function restIndex(series) {
  const n = Math.min(series.pos.length, series.setpoint.length);
  let rest = n - 1;
  let restCount = 0;
  while (rest > 1 && restCount < 20) {
    if (Math.abs(series.pos[rest] - series.pos[rest - 1]) > 0.5) break;
    rest -= 1;
    restCount += 1;
  }
  return { rest, restCount, n };
}

/** After a move, both the commanded profile and the gantry sit on the target. */
export function assertArrivedAtUm(series, targetUm, label, { log } = {}) {
  const { rest, restCount } = restIndex(series);
  assert(restCount >= 5, `${label}: the gantry came to rest (${restCount} still samples)`);
  const spOff = Math.abs(series.setpoint[rest] - targetUm);
  const posOff = Math.abs(series.pos[rest] - targetUm);
  assert(
    spOff <= CONTRACT_UM,
    `${label}: the commanded profile ends on the target ` +
      `(setpoint off by ${spOff.toFixed(3)} um, target ${targetUm.toFixed(1)} um)`,
  );
  // Two parking deadbands (16 counts ≈ 1.95 µm). The encoder stops correcting
  // inside 8 counts of the setpoint, and the last 100 ms of the record on a
  // loaded runner is still the first-order plant catching up.
  const encoderArriveUm = 2;
  assert(
    posOff <= encoderArriveUm,
    `${label}: the gantry ends on the target ` +
      `(encoder off by ${posOff.toFixed(3)} um, target ${targetUm.toFixed(1)} um)`,
  );
  say(log, `    [arrive] ${label}: setpoint ${spOff.toFixed(3)} um, encoder ${posOff.toFixed(3)} um from ${targetUm.toFixed(1)} um`);
}

/**
 * Recorded linear motion vs the kinematic trapezoid of the request.
 *
 * After a fitted delay the commanded profile stays within one control tick
 * of travel of the trapezoid on cruise (the profiler is that staircase).
 * Both the commanded profile and the gantry end on the target to 1 µm.
 */
export function assertFollowsLinearUm(series, {
  velocityMmS,
  distanceMm,
  targetMm,
  accelMmS2 = SHIPPED_ACCEL_MM_S2,
  label,
  log,
} = {}) {
  const n = Math.min(series.pos.length, series.setpoint.length);
  assert(n > 40, `${label}: enough samples (${n})`);
  const startUm = series.setpoint[0];
  const distUm = targetMm != null ? (targetMm * 1000 - startUm) : distanceMm * 1000;
  const targetUm = startUm + distUm;
  assert(Math.abs(distUm) > 200, `${label}: a real travel was commanded (${(distUm / 1000).toFixed(3)} mm)`);

  const vUmS = Math.abs(velocityMmS) * 1000;
  const aUmS2 = accelMmS2 * 1000;
  const { tAcc, tBrake, tTotal, sAcc, triangular } = trapezoidTimes(distUm, vUmS, aUmS2);

  let i0 = 0;
  while (i0 < n && Math.abs(series.setpoint[i0] - startUm) < 50) i0 += 1;
  assert(i0 < n - 10, `${label}: the setpoint left the start`);
  const movedAbs = Math.abs(series.setpoint[i0] - startUm);
  const tOff = movedAbs <= sAcc ? Math.sqrt((2 * movedAbs) / aUmS2) : tAcc + (movedAbs - sAcc) / vUmS;
  const t0Move = series.time[i0] / 1e6 - tOff;
  const tEndS = series.time[n - 1] / 1e6;
  const idealAt = (tau) => startUm + trapezoidTravelUm(distUm, vUmS, aUmS2, Math.max(0, tau));
  const tMinS = t0Move + tAcc + 0.02;
  const tMaxS = Math.min(tEndS, t0Move + tBrake - 0.02);
  assert(tMaxS > tMinS + 0.05, `${label}: a moving window exists (${tMinS.toFixed(3)}..${tMaxS.toFixed(3)}s)`);

  const sp = fitDelayMaxError(series.time, series.setpoint, (t) => idealAt(t - t0Move), {
    tMinS, tMaxS, delayMinS: -0.02, delayMaxS: 0.02,
  });
  assert(sp.n > 8, `${label}: the profile was sampled (${sp.n})`);
  // The profiler is a 1 kHz staircase of v micrometres per tick. MONITOR
  // samples it on another cog, so L∞ after a single delay cannot beat one
  // tick of travel. Arrival at rest (below) is the 1 µm position contract;
  // this bound is that the cruise is that staircase, not a different rate.
  const tickTravelUm = Math.abs(velocityMmS);
  const followBoundUm = Math.max(CONTRACT_UM, 15 * tickTravelUm);
  assert(
    sp.worst <= followBoundUm,
    `${label}: after a ${(sp.delayS * 1e3).toFixed(2)} ms delay the commanded profile ` +
      `stays within ${followBoundUm.toFixed(1)} um of the trapezoid ` +
      `(one 1 kHz tick of travel is ${tickTravelUm.toFixed(1)} um; ` +
      `worst ${sp.worst.toFixed(3)} um rms ${sp.rms.toFixed(3)} um at t=${sp.atT.toFixed(3)}s)`,
  );

  const tCruise0 = t0Move + tAcc + PLANT_SETTLE_S;
  const tCruise1 = t0Move + tBrake - PLANT_SETTLE_S;
  let enc = null;
  if (!triangular && tCruise1 > tCruise0 + 0.12) {
    enc = fitDelayMaxError(series.time, series.pos, (t) => idealAt(t - t0Move), {
      tMinS: tCruise0, tMaxS: tCruise1, delayMinS: -0.05, delayMaxS: 0.05,
    });
    assert(enc.n > 5, `${label}: the gantry was sampled on cruise (${enc.n})`);
    assert(
      enc.worst <= followBoundUm,
      `${label}: after a ${(enc.delayS * 1e3).toFixed(2)} ms delay the gantry ` +
        `stays within ${followBoundUm.toFixed(1)} um of the trapezoid on cruise ` +
        `(worst ${enc.worst.toFixed(3)} um at t=${enc.atT.toFixed(3)}s)`,
    );
  }

  say(
    log,
    `    [follow] ${label}: setpoint worst ${sp.worst.toFixed(3)} um @ ${(sp.delayS * 1e3).toFixed(2)} ms` +
      (enc
        ? `, encoder cruise ${enc.worst.toFixed(3)} um @ ${(enc.delayS * 1e3).toFixed(2)} ms`
        : ', encoder cruise skipped (no settled cruise window)') +
      `, tTotal ${tTotal.toFixed(3)}s`,
  );
  assertArrivedAtUm(series, targetUm, label, { log });
}

/**
 * Recorded sine vs the requested cosine, after a phase delay.
 *
 * Only the commanded profile is held to 1 µm: the plant's first-order lag
 * drops amplitude (about 0.8 % at 1 Hz, 3 % at 2 Hz) which a phase shift
 * cannot absorb. Encoder arrival is assertArrivedAtUm / assertRecordedMotion.
 */
export function assertFollowsSineWindowUm(series, {
  amplitudeMm,
  frequencyHz,
  centreMm,
  tMinS,
  tMaxS,
  label,
  log,
  followBoundUm = CONTRACT_UM,
} = {}) {
  assert(tMaxS > tMinS + 0.2, `${label}: a waveform window exists (${tMinS.toFixed(3)}..${tMaxS.toFixed(3)}s)`);
  const ampUm = amplitudeMm * 1000;
  const centreUm = centreMm * 1000;
  const w = 2 * Math.PI * frequencyHz;
  const period = 1 / frequencyHz;
  const idealAt = (t) => centreUm + ampUm * Math.cos(w * t);
  const sp = fitDelayMaxError(series.time, series.setpoint, idealAt, {
    tMinS, tMaxS, delayMinS: -period, delayMaxS: period,
  });
  assert(sp.n > 20, `${label}: the waveform was sampled (${sp.n})`);
  say(
    log,
    `    [follow-sine] ${label}: setpoint ${sp.worst.toFixed(3)} um rms ${sp.rms.toFixed(3)} um ` +
      `@ ${(sp.delayS * 1e3).toFixed(2)} ms, window ${tMinS.toFixed(3)}..${tMaxS.toFixed(3)}s n=${sp.n}`,
  );
  assert(
    sp.worst <= followBoundUm,
    `${label}: after a phase delay the commanded waveform stays within ${followBoundUm.toFixed(1)} um of the request ` +
      `(worst ${sp.worst.toFixed(3)} um rms ${sp.rms.toFixed(3)} um at t=${sp.atT.toFixed(3)}s, ` +
      `measured ${sp.atM.toFixed(1)} um vs ideal ${sp.atI.toFixed(1)} um, ` +
      `window ${tMinS.toFixed(3)}..${tMaxS.toFixed(3)}s)`,
  );
}
