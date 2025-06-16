import MaDSim
from time import sleep

# The base port should be sent to firmware cause it sometimes has conflicts with existing ports
# MAYBE ONCE STABLE RUN IN DOCKER
socket_port_base = 9600

# Build firmware
firmware = MaDSim.FirmwareRunner("native", "../")
firmware.clean()
firmware.build()

# Create a socket connection for each 64 pins
async_server = []
for i in range(64):
    async_server.append(MaDSim.AsyncSocketServer("localhost", socket_port_base + i))
    async_server[i].run()

# Connect ESD pins
#define CHARGE_PUMP_PIN 28
#define ESD_POWER_PIN GPI_3
#define ESD_UPPER_PIN 16
#define ESD_LOWER_PIN 17
#define ESD_SWITCH_PIN 18
#define ENDSTOP_UPPER_PIN 19
#define ENDSTOP_LOWER_PIN 20
#define ENDSTOP_DOOR_PIN 21

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
#define PIN_SERVO_ENA 6 // Servo enable pin
#define PIN_SERVO_PUL 8 // Servo pulse pin
#define PIN_SERVO_DIR 7 // Servo direction pin
#define PIN_SERVO_RDY 5 // Servo ready pin
#define SERVO_ENCODER_A 9
#define SERVO_ENCODER_B 10
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
#rpi_serial = MaDSim.VirtualSerialPort("rpi_client", "rpi") #run it manually, its easier lol
rpi_async_serial_server = MaDSim.AsyncSerialServer("rpi_client")
MaDSim.AsyncConectorSingle(rpi_async_serial_server, async_server[53])
MaDSim.AsyncConectorSingle(async_server[55], rpi_async_serial_server)
#rpi_serial.start()
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

try:
    while True:
        if not firmware.is_running():
            MaDSim.logger.error("Firmware has stopped, Exiting server process")
            break
        #if not rpi_serial.is_running():
        #    MaDSim.logger.error("RPI VSP has stopped, Exiting server process")
        #    break
        if not rpi_async_serial_server.is_running():
            MaDSim.logger.error("RPI async serial server has stopped, Exiting server process")
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
finally:
    firmware.stop()
    for async_server_instance in async_server:
            if not async_server_instance.stop():
                MaDSim.logger.error("Async server has stopped, Exiting server process")
                break
    MaDSim.async_handler.stop_loop()