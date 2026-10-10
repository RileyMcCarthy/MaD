/**
 * Entry point of the device worker (see session.ts, which spawns it).
 *
 * Starts loading the protocol core, then exposes one DeviceSession to the main
 * thread over Comlink. The session itself lives in DeviceSession.worker.ts.
 */

import * as Comlink from 'comlink';
import { DeviceSession, startProtocolCore } from './DeviceSession.worker';

void startProtocolCore();
Comlink.expose(new DeviceSession());
