import asyncio
import serial_asyncio
from . import logger, sim_loop, SERIAL_PORT_PATH
from .Async import AsyncHandler

class AsyncSerialServer(AsyncHandler, asyncio.Protocol):
    def __init__(self, port='ttyS1', baudrate=115200):
        super().__init__()
        self.port = f"{SERIAL_PORT_PATH}{port}"
        self.baudrate = baudrate
        self.server = None
        self.running = False
        self.transport = None
        self.lock = asyncio.Lock()

    def connection_made(self, transport):
        logger.info(f'Serial connection made: {self.port}')
        self.transport = transport

    def data_received(self, data):
        #logger.info(f'Data received from {self.port}: {data}')
        self.tx(data)

    def send(self, data):
        if self.transport is not None:
            self.transport.write(data)

    def connection_lost(self, exc):
        logger.warn(f'The server closed the connection: {self.port}')
        self.transport = None

    # override of AsyncHandler method
    def rx(self, data: bytes):
        try:
            self.send(data)
        except Exception as e:
            logger.error(f"Error sending data {self.host}:{self.port}: {e}")

    async def start_server(self):
        self.server = await serial_asyncio.create_serial_connection(sim_loop, lambda: self, self.port, self.baudrate)
        logger.info(f'Serial server started on {self.port}')

    def is_running(self):
        return self.running

    def run(self):
        logger.info('Starting serial server')
        try:
            self.running = True
            asyncio.run_coroutine_threadsafe(self.start_server(), sim_loop)
        except RuntimeError:
            logger.warn('No event loop found')

    def stop(self):
        if self.server is not None:
            self.server.close()
            self.server = None
        self.running = False
        logger.info(f'Serial server stopped on {self.port}')