import asyncio
import threading
from . import logger

class AsyncLoopHandler:
    def __init__(self):
        self.loop = None
        self.thread = None

    def start_loop(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.loop.set_exception_handler(self.handle_exception)
        self.thread = threading.Thread(target=self.loop.run_forever)
        self.thread.start()

    def stop_loop(self):
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self.loop.stop)
            if self.thread is not threading.current_thread():
                self.thread.join()
            self.thread = None
            self.loop = None

    def handle_exception(self, loop, context):
        logger.error(f"Caught exception: {context}")
        logger.error(f"Stopping the loop")
        self.stop_loop()

    def is_running(self):
        return self.thread is not None and self.thread.is_alive()
    
    def get_loop(self):
        return self.loop
    