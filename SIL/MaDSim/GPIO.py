from . import logger
import asyncio
from .Async import AsyncHandler
from . import sim_loop
import struct

class GPIO(AsyncHandler):
    def __init__(self):
        super().__init__()
        self.state = 0
        self.rx_callback = None

    def set_rx_callback(self, callback):
        self.rx_callback = callback

    def rx(self, data: bytes):
        if self.rx_callback:
            self.rx_callback(data)
        else:
            logger.warn(f"GPIO: No callback set for rx")

    def set_state(self, state):
        self.state = state
        byte = state.to_bytes(1, byteorder='big')
        self.tx(byte)