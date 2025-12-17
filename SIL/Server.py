import MaDSim
from time import sleep
import os
import signal
import sys
import argparse
import subprocess
import shutil

# The base port should be sent to firmware cause it sometimes has conflicts with existing ports
# MAYBE ONCE STABLE RUN IN DOCKER
socket_port_base = 9600

# Setup virtual serial ports for UI testing
print("Setting up virtual serial ports...")
rpi_virtual_port = MaDSim.VirtualSerialPort("rpi_client", "rpi")
rpi_virtual_port.start()
sleep(2)
print("✅ Virtual serial ports created: /tmp/tty.rpi_client and /tmp/tty.rpi")

# CLI arguments
parser = argparse.ArgumentParser(description='MaD SIL Emulator and Test Runner')
parser.add_argument('--skip-tests', action='store_true', help='Skip running Playwright tests (dev mode)')
parser.add_argument('--headed', action='store_true', help='Run Playwright in headed mode')
parser.add_argument('--skip-app-build', action='store_true', help='Skip Electron app build even if artifacts missing')
parser.add_argument('--rebuild', action='store_true', help='Clean all SIL build artifacts before building')
args, _ = parser.parse_known_args()


# Build/check artifacts prior to starting emulator
script_dir = os.path.dirname(os.path.abspath(__file__))
sil_root = script_dir
project_root = os.path.abspath(os.path.join(script_dir, '..'))

# Optionally clean build artifacts first
if args.rebuild:
    try:
        build_dir = os.path.join(script_dir, 'build')
        if os.path.isdir(build_dir):
            shutil.rmtree(build_dir)
            print('🧹 Cleaned SIL/build directory')
    except Exception as e:
        print(f"⚠️  Failed to clean build directory: {e}")

# Prepare Electron app and Playwright deps first (if tests are enabled)
if not args.skip_tests:
    electron_runner = MaDSim.ElectronRunner(
        sil_root=sil_root,
        project_root=project_root,
        skip_build=args.skip_app_build,
        headed=args.headed,
        rebuild=args.rebuild,
    )
    electron_runner.prepare()

# Firmware: First check for prebuilt binary in SIL/build/firmware
mad_core_executable = os.path.join(sil_root, "build/firmware/mad-firmware-native.bin")

fw_src = os.path.join(project_root, "Firmware", "MaDCore")
if not os.path.exists(mad_core_executable):
    print("No prebuilt firmware found, building from source...")
    print(f"Checked path: {mad_core_executable}")
    # Build firmware in source tree
    tmp_runner = MaDSim.FirmwareRunner("native", fw_src)
    tmp_runner.clean()
    tmp_runner.build()

    # Copy the compiled program into SIL/build and use it consistently
    program_path = os.path.join(fw_src, ".pio", "build", "native", "program")
    os.makedirs(os.path.dirname(mad_core_executable), exist_ok=True)
    shutil.copy2(program_path, mad_core_executable)
    try:
        os.chmod(mad_core_executable, 0o755)
    except Exception:
        pass
    print(f"✅ Copied firmware to {mad_core_executable}")

# Create runner pointing to the copied artifact
firmware = MaDSim.FirmwareRunner("native", fw_src, mad_core_executable)

# Create a socket connection for each 64 pins
async_server = []
for i in range(64):
    async_server.append(MaDSim.AsyncSocketServer("localhost", socket_port_base + i))
    async_server[i].run()

charge_pump = MaDSim.GPIO()
MaDSim.AsyncConnector(charge_pump, async_server[28])

esd_power = MaDSim.GPIO()
MaDSim.AsyncConnector(esd_power, async_server[3])

esd_upper = MaDSim.GPIO()
MaDSim.AsyncConnector(esd_upper, async_server[16])

esd_lower = MaDSim.GPIO()
MaDSim.AsyncConnector(esd_lower, async_server[17])

esd_switch = MaDSim.GPIO()
MaDSim.AsyncConnector(esd_switch, async_server[18])

endstop_upper = MaDSim.GPIO()
MaDSim.AsyncConnector(endstop_upper, async_server[19])

endstop_lower = MaDSim.GPIO()
MaDSim.AsyncConnector(endstop_lower, async_server[20])

endstop_door = MaDSim.GPIO()
MaDSim.AsyncConnector(endstop_door, async_server[21])


# Connect servo pins
servo_step = MaDSim.GPIO()
MaDSim.AsyncConnector(servo_step, async_server[8])
servo_dir = MaDSim.GPIO()
MaDSim.AsyncConnector(servo_dir, async_server[7])
servo_ready = MaDSim.GPIO()
MaDSim.AsyncConnector(servo_ready, async_server[5])
servo_ena = MaDSim.GPIO()
MaDSim.AsyncConnector(servo_ena, async_server[6])
servo_enc_a = MaDSim.GPIO()
MaDSim.AsyncConnector(servo_enc_a, async_server[9])
servo_enc_b = MaDSim.GPIO()
MaDSim.AsyncConnector(servo_enc_b, async_server[10])
servo = MaDSim.Servo(servo_step, servo_dir, servo_enc_a, servo_enc_b, endstop_upper)

forceGauge = MaDSim.SimulatedADS122U04()
MaDSim.AsyncConectorSingle(forceGauge, async_server[0])
MaDSim.AsyncConectorSingle(async_server[2], forceGauge)
sample = MaDSim.TestSample(servo, forceGauge)

# socat -d -d pty,raw,echo=0,link=/tmp/tty.rpi_client pty,raw,echo=0,link=/tmp/tty.rpi
rpi_pin = 53
rpi_async_serial_server = MaDSim.AsyncSerialServer("rpi_client")
MaDSim.AsyncConectorSingle(rpi_async_serial_server, async_server[53])
MaDSim.AsyncConectorSingle(async_server[55], rpi_async_serial_server)
rpi_async_serial_server.run()

firmware.run()

sleep(5)

# need better check for sockets connected
charge_pump.set_state(0)
esd_switch.set_state(1)
esd_power.set_state(1)
esd_upper.set_state(1)
esd_lower.set_state(1)
esd_switch.set_state(1)
endstop_upper.set_state(0)
endstop_lower.set_state(0)
endstop_door.set_state(0)

if not args.skip_tests:
    electron_runner.run_tests()
try:
    while True:
        if not firmware.is_running():
            MaDSim.logger.error("Firmware has stopped, Exiting server process")
            break
        if not rpi_async_serial_server.is_running():
            MaDSim.logger.error("RPI async serial server has stopped, Exiting server process")
            break
        if not rpi_virtual_port.is_running():
            MaDSim.logger.error("RPI virtual serial port has stopped, Exiting server process")
            break
        if not MaDSim.async_handler.is_running():
            MaDSim.logger.error("Async handler has stopped, Exiting server process")
            break
        for async_server_instance in async_server:
            if not async_server_instance.is_running():
                MaDSim.logger.error("Async server has stopped, Exiting server process")
                break
        sample.apply_force()
        sleep(0.1)
        # If tests were started and finished, exit
        if not args.skip_tests and electron_runner.has_finished():
            print('✅ Playwright tests finished; shutting down emulator...')
            break
except KeyboardInterrupt:
    print("Received shutdown signal, cleaning up...")
finally:
    print("Cleaning up processes...")
    firmware.stop()
    for async_server_instance in async_server:
            if not async_server_instance.stop():
                MaDSim.logger.error("Async server has stopped, Exiting server process")
                break
    MaDSim.async_handler.stop_loop()
    if not args.skip_tests:
        electron_runner.stop()
    # Cleanup virtual serial port
    try:
        if 'rpi_virtual_port' in locals() and rpi_virtual_port and rpi_virtual_port.is_running():
            rpi_virtual_port.stop()
            print("✅ Virtual serial ports cleaned up")
    except Exception as e:
        print(f"⚠️ Error cleaning up virtual serial port: {e}")
    
    print("Server shutdown complete.")