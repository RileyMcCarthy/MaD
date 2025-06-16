from . import logger
import asyncio
from .Async import AsyncHandler
from . import sim_loop
import struct

class SimulatedADS122U04(AsyncHandler):
    STATUS_SUCCESS = "SUCCESS"
    STATUS_INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
    STATUS_INVALID_SYNC_BYTE = "INVALID_SYNC_BYTE"
    STATUS_INVALID_COMMAND = "INVALID_COMMAND"

    def __init__(self):
        self.registers = {
            0x00: 0x00,  # Configuration Register 0
            0x01: 0x00,  # Configuration Register 1
            0x02: 0x00,  # Configuration Register 2
            0x03: 0x00,  # Configuration Register 3
            # Add more registers as needed
        }
        self.data = []
        sim_loop.create_task(self.send_data_loop())
        self.continuous_data = False
        self.force = 200

    def clear_data(self):
        self.data.clear()

    def write_register(self, register, value):
        # Simulate writing to registers
        self.registers[register] = value

    def read_register(self, register):
        # Simulate reading from registers
        return self.registers.get(register, 0)

    async def send_data_loop(self):
        while True:
            if self.continuous_data:
                value = self.ads_value.to_bytes(length=4, byteorder='little', signed=False)
                value3bytes = value[0:3]
                #logger.info(f"Sending data: {value3bytes[0]} {value3bytes[1]} {value3bytes[2]}")
                self.tx(value3bytes)
                #self.tx(bytes([0x55, 0x00, 0x10, 0x01]))
            await asyncio.sleep(0.01)

    def process_serial_data(self, byte: bytes):
        # Append the byte to the bytearray
        self.data.append(byte)
        logger.info(f'Current data: {self.data}')
        if len(self.data) == 1:
            if self.data[0] != 0x55:
                self.data.clear()
                logger.warning("byte not 0x55")
        elif len(self.data) in [2,3]:
            command = (self.data[1] >> 4) & 0x0F  # Mask the upper nibble
            register_address = (self.data[1] >> 1) & 0x0F  # Mask the lower nibble
            if self.data[1] == 0x01:
                # some command, do something
                logger.info("executing command 0x01")
                self.clear_data()
                self.continuous_data = False
            elif self.data[1] == 0x06:
                # reset ads122u04
                logger.info("executing command 0x06")
                self.clear_data()
                self.continuous_data = False
            elif self.data[1] == 0x08:
                # continuous data mode
                # create a thread to send data continuously
                logger.info("executing command 0x08")
                self.continuous_data = True
                self.clear_data()
            elif command == 0b0010:
                # Simulate read operation
                res = self.read_register(register_address)
                self.tx(bytes([res]))
                logger.info(f"Read register {register_address} with value {res}")
                self.clear_data()
            elif command == 0b0100:
                # Simulate write operation
                if len(self.data) == 3:  # Adjusted length for the value bytes
                    value = self.data[2]
                    self.write_register(register_address, value)
                    logger.info(f"Wrote value {value} to register {register_address}")
                    self.clear_data()
            else:
                logger.info("invalid command")
                self.clear_data()
        else:
            logger.info("no commands with 4 bytes")
            self.clear_data()
    
    def rx(self, data: bytes) -> bytes:
        for byte in data:
            self.process_serial_data(byte)
    
    def set_force(self, force):
        self.force = force

    def get_force(self):
        return self.force
    
    @property
    def ads_value(self):
        return (int)(self.force * -658) + 16119601
