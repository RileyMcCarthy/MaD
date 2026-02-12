// MaD Machine Visualizer — real-time machine state display
//
// Coordinate system (matches firmware app_monitor.c):
//   Origin (0mm) = upper jaw grip lip (stationary, fixed above track)
//   Positive X   = downward, from upper jaw toward lower jaw
//   Upper endstop at −10mm  (triggers when position < −10mm)
//   Lower endstop at 300mm  (triggers when position > 300mm)
//
// The upper jaw is fixed above the track. The track spans the full
// travel range. The gantry (lower jaw) moves within the track.
// ESD limits are GPIO-only inputs (not position-triggered in the model).

// ============================================================
// Constants — match wiring.rs / limit_switch model
// ============================================================

const ENDSTOP_UPPER_MM = -10;      // limit_switch upper_threshold_mm
const ENDSTOP_LOWER_MM = 300;      // limit_switch lower_threshold_mm

// Visual track range: show some margin beyond each endstop
const TRACK_MIN_MM = ENDSTOP_UPPER_MM - 15;  // -25mm
const TRACK_MAX_MM = ENDSTOP_LOWER_MM + 25;  //  325mm

// State / fault / restriction enum mappings (match firmware app_control.h)
const STATE_NAMES = ['DISABLED', 'RESTRICTED', 'MANUAL', 'TEST'];
const FAULT_NAMES = [
  'NONE', 'COG', 'WATCHDOG', 'ESD_POWER', 'ESD_SWITCH',
  'ESD_UPPER', 'ESD_LOWER', 'SERVO_COMM', 'FORCE_GAUGE_COMM'
];
const RESTRICTION_NAMES = [
  'NONE', 'SAMPLE_LENGTH', 'SAMPLE_TENSION', 'MACHINE_TENSION',
  'UPPER_ENDSTOP', 'LOWER_ENDSTOP', 'DOOR'
];

// ============================================================
// WebSocket connection
// ============================================================

let ws = null;
let reconnectTimer = null;

// Current machine state (updated from WS messages)
const machineState = {
  // Position & motion
  position_mm: 0,
  encoder_steps: 0,
  servo_enabled: false,
  direction_cw: true,

  // Force
  force_n: 0,
  strain_mv: 0,

  // Endstops (position-triggered via limit_switch model)
  endstop_upper: false,
  endstop_lower: false,

  // GPIO (ESD are GPIO-only, not position-based)
  esd_upper: false,
  esd_lower: false,
  esd_switch: false,
  esd_power: false,
  door: false,
  charge_pump: false,
  servo_ready: false,

  // Firmware state (from C variables, if available)
  fw_state: null,
  fw_fault: null,
  fw_restriction: null,
  fw_motion_enabled: null,
  fw_test_running: null,
};

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + location.host + '/ws/machine';
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[machine] WebSocket connected');
    ws.send(JSON.stringify({
      cmd: 'subscribe',
      signals: [
        'stepper.position_mm', 'encoder.position',
        'stepper.enabled', 'stepper.direction_cw',
        'sample.force_n', 'strain_gauge.voltage_mv',
        'limit_switch.upper', 'limit_switch.lower',
        'gpio.servo_ena', 'gpio.servo_dir',
      ]
    }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.warn('[machine] Parse error:', e);
    }
  };

  ws.onclose = () => {
    console.log('[machine] WebSocket closed, reconnecting...');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function handleMessage(msg) {
  // Trace data updates
  if (msg.data) {
    for (const [name, samples] of Object.entries(msg.data)) {
      if (samples.length === 0) continue;
      const last = samples[samples.length - 1].value;

      switch (name) {
        case 'stepper.position_mm':   machineState.position_mm = last; break;
        case 'encoder.position':      machineState.encoder_steps = last; break;
        case 'stepper.enabled':       machineState.servo_enabled = last > 0.5; break;
        case 'stepper.direction_cw':  machineState.direction_cw = last > 0.5; break;
        case 'sample.force_n':        machineState.force_n = last; break;
        case 'strain_gauge.voltage_mv': machineState.strain_mv = last; break;
        case 'limit_switch.upper':    machineState.endstop_upper = last > 0.5; break;
        case 'limit_switch.lower':    machineState.endstop_lower = last > 0.5; break;
        case 'gpio.servo_ena':        machineState.servo_enabled = last > 0.5; break;
        case 'gpio.servo_dir':        machineState.direction_cw = last < 0.5; break;
      }
    }
  }

  // GPIO state snapshot
  if (msg.gpio) {
    const g = msg.gpio;
    if (g.esd_upper !== undefined)    machineState.esd_upper = g.esd_upper;
    if (g.esd_lower !== undefined)    machineState.esd_lower = g.esd_lower;
    if (g.esd_switch !== undefined)   machineState.esd_switch = g.esd_switch;
    if (g.esd_power !== undefined)    machineState.esd_power = g.esd_power;
    if (g.endstop_door !== undefined) machineState.door = g.endstop_door;
    if (g.charge_pump !== undefined)  machineState.charge_pump = g.charge_pump;
    if (g.servo_ready !== undefined)  machineState.servo_ready = g.servo_ready;
  }

  // Firmware state (from C variable polling)
  if (msg.firmware) {
    const fw = msg.firmware;
    if (fw.state !== undefined)          machineState.fw_state = fw.state;
    if (fw.fault !== undefined)          machineState.fw_fault = fw.fault;
    if (fw.restriction !== undefined)    machineState.fw_restriction = fw.restriction;
    if (fw.motion_enabled !== undefined) machineState.fw_motion_enabled = fw.motion_enabled;
    if (fw.test_running !== undefined)   machineState.fw_test_running = fw.test_running;
  }
}

// ============================================================
// Coordinate mapping
// ============================================================

/** Convert mm position to percentage within the visual track (0% = top, 100% = bottom). */
function mmToPercent(mm) {
  return ((mm - TRACK_MIN_MM) / (TRACK_MAX_MM - TRACK_MIN_MM)) * 100;
}

// ============================================================
// Build ruler with accurate mm scale
// ============================================================

function buildRuler() {
  const ruler = document.getElementById('ruler');
  ruler.innerHTML = '';

  const STEP = 50; // mm between major ticks

  // Determine range of major ticks to draw
  const startMm = Math.ceil(TRACK_MIN_MM / STEP) * STEP;
  const endMm = Math.floor(TRACK_MAX_MM / STEP) * STEP;

  for (let mm = startMm; mm <= endMm; mm += STEP) {
    const pct = mmToPercent(mm);
    if (pct < 0 || pct > 100) continue;

    // Major tick
    const tick = document.createElement('div');
    tick.className = 'ruler-tick major' + (mm === 0 ? ' origin' : '');
    tick.style.top = pct + '%';
    ruler.appendChild(tick);

    // Label
    const label = document.createElement('div');
    label.className = 'ruler-tick-label' + (mm === 0 ? ' origin' : '');
    label.style.top = pct + '%';
    label.textContent = mm + ' mm';
    ruler.appendChild(label);

    // Minor ticks every 10mm
    for (let sub = 10; sub < STEP; sub += 10) {
      const subMm = mm + sub;
      if (subMm > TRACK_MAX_MM) break;
      const subPct = mmToPercent(subMm);
      if (subPct < 0 || subPct > 100) continue;
      const subTick = document.createElement('div');
      subTick.className = 'ruler-tick';
      subTick.style.top = subPct + '%';
      ruler.appendChild(subTick);
    }
  }
}

// ============================================================
// Rendering — called at 30fps
// ============================================================

function render() {
  const s = machineState;

  // ── Gantry/lower jaw at current position ──
  const gantryPct = mmToPercent(s.position_mm);
  const gantry = document.getElementById('gantry');
  gantry.style.top = gantryPct + '%';

  // Position readout on gantry
  document.getElementById('gantryReadout').textContent = s.position_mm.toFixed(3) + ' mm';

  // ── Sample stretches from upper jaw (0mm = top of track mapped) down to gantry ──
  const sample = document.getElementById('sample');
  const originPct = mmToPercent(0);
  const sampleHeightPct = Math.max(0, gantryPct - originPct);
  sample.style.top = originPct + '%';
  sample.style.height = sampleHeightPct + '%';

  const sampleLabel = document.getElementById('sampleLabel');
  if (s.force_n !== 0 && sampleHeightPct > 2) {
    sampleLabel.textContent = Math.abs(s.force_n).toFixed(1) + ' N';
  } else {
    sampleLabel.textContent = '';
  }

  // ── Endstop positions (fixed, from limit_switch config) ──
  const endstopUpperEl = document.getElementById('endstopUpper');
  const endstopLowerEl = document.getElementById('endstopLower');
  endstopUpperEl.style.top = mmToPercent(ENDSTOP_UPPER_MM) + '%';
  endstopLowerEl.style.top = mmToPercent(ENDSTOP_LOWER_MM) + '%';

  // Triggered visual state
  endstopUpperEl.classList.toggle('triggered', s.endstop_upper);
  endstopLowerEl.classList.toggle('triggered', s.endstop_lower);

  // ── Force gauge ──
  const forceEl = document.getElementById('forceValue');
  forceEl.textContent = s.force_n.toFixed(3) + ' N';
  forceEl.classList.toggle('tension', s.force_n > 0.01);

  // ── Info panels ──

  // State
  const stateEl = document.getElementById('stateValue');
  if (s.fw_state !== null) {
    const stateName = STATE_NAMES[s.fw_state] || 'UNKNOWN';
    stateEl.textContent = stateName;
    stateEl.className = 'info-value state-' + stateName.toLowerCase();
  } else {
    stateEl.textContent = '—';
    stateEl.className = 'info-value';
  }

  // Fault
  const faultEl = document.getElementById('faultValue');
  if (s.fw_fault !== null) {
    const faultName = FAULT_NAMES[s.fw_fault] || 'UNKNOWN';
    faultEl.textContent = faultName;
    faultEl.className = 'info-value ' + (s.fw_fault === 0 ? 'ok' : 'fault');
  }

  // Restriction
  const restrictEl = document.getElementById('restrictionValue');
  if (s.fw_restriction !== null) {
    const restrictName = RESTRICTION_NAMES[s.fw_restriction] || 'UNKNOWN';
    restrictEl.textContent = restrictName;
    restrictEl.className = 'info-value ' + (s.fw_restriction === 0 ? 'ok' : 'fault');
  }

  // Motion enabled
  const motionEl = document.getElementById('motionEnabledValue');
  if (s.fw_motion_enabled !== null) {
    motionEl.textContent = s.fw_motion_enabled ? 'YES' : 'NO';
    motionEl.className = 'info-value ' + (s.fw_motion_enabled ? 'on' : 'off');
  }

  // Test running
  const testEl = document.getElementById('testRunningValue');
  if (s.fw_test_running !== null) {
    testEl.textContent = s.fw_test_running ? 'RUNNING' : 'IDLE';
    testEl.className = 'info-value ' + (s.fw_test_running ? 'state-test' : 'off');
  }

  // Position & motion info
  document.getElementById('positionValue').textContent = s.position_mm.toFixed(3) + ' mm';
  document.getElementById('encoderValue').textContent = Math.round(s.encoder_steps) + ' steps';
  document.getElementById('servoEnaValue').textContent = s.servo_enabled ? 'ON' : 'OFF';
  document.getElementById('servoEnaValue').className = 'info-value ' + (s.servo_enabled ? 'on' : 'off');
  document.getElementById('directionValue').textContent = s.direction_cw ? 'CW ↓' : 'CCW ↑';

  // Force info
  document.getElementById('forceInfoValue').textContent = s.force_n.toFixed(3) + ' N';
  document.getElementById('strainValue').textContent = s.strain_mv.toFixed(3) + ' mV';

  // ── Endstop status panel ──
  setEndstopStatus('statusEndstopUpper', s.endstop_upper);
  setEndstopStatus('statusEndstopLower', s.endstop_lower);

  // ── GPIO LEDs ──
  setLed('gpioEndstopUpper', s.endstop_upper, false);
  setLed('gpioEndstopLower', s.endstop_lower, false);
  setLed('gpioEsdUpper', s.esd_upper, true);
  setLed('gpioEsdLower', s.esd_lower, true);
  setLed('gpioEsdSwitch', s.esd_switch, true);
  setLed('gpioEsdPower', s.esd_power, true);
  setLed('gpioDoor', s.door, false);
  setLed('gpioChargePump', s.charge_pump, false);
  setLed('gpioServoReady', s.servo_ready, false);
}

function setEndstopStatus(elementId, active) {
  const row = document.getElementById(elementId);
  if (!row) return;
  const indicator = row.querySelector('.endstop-status-indicator');
  if (!indicator) return;
  indicator.className = 'endstop-status-indicator ' + (active ? 'on' : 'off');
}

function setLed(elementId, active, isEsd) {
  const item = document.getElementById(elementId);
  if (!item) return;
  const led = item.querySelector('.gpio-led');
  if (!led) return;
  led.className = 'gpio-led ' + (active ? 'on' : 'off') + (active && isEsd ? ' esd' : '');
}

// ============================================================
// Init
// ============================================================

buildRuler();
connect();

// Render at 30fps
setInterval(render, 33);
