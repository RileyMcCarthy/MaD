import subprocess
import os
from . import logger, SERIAL_PORT_PATH
from .Async import AsyncHandler

class VirtualSerialPort():
    def __init__(self, link1, link2):
        self.link1 = link1
        self.link2 = link2
        self.process = None
    
    @staticmethod
    def kill_socat():
        subprocess.run(['pkill', '-f', 'socat'])

    def start(self):
        if self.is_running():
            logger.warning("Virtual serial port is already running")
        else:
            port1 = f"{SERIAL_PORT_PATH}{self.link1}"
            port2 = f"{SERIAL_PORT_PATH}{self.link2}"
            command = f"socat -d -d pty,raw,echo=0,link={port1} pty,raw,echo=0,link={port2}"
            
            logger.info(f"Starting socat: {command}")
            
            # Start socat and redirect all output to logger
            import threading
            
            def log_output(pipe, log_level):
                for line in iter(pipe.readline, ''):
                    if line.strip():
                        log_level(f"socat: {line.strip()}")
                pipe.close()
            
            self.process = subprocess.Popen(
                command, 
                shell=True, 
                stdout=subprocess.PIPE, 
                stderr=subprocess.STDOUT,  # Merge stderr into stdout
                universal_newlines=True,
                bufsize=1
            )
            
            # Start logging thread
            self.log_thread = threading.Thread(
                target=log_output, 
                args=(self.process.stdout, logger.info),
                daemon=True
            )
            self.log_thread.start()

    def stop(self):
        if self.process:
            logger.info(f"Stopping socat process (PID: {self.process.pid})")
            self.process.terminate()
            self.process.wait(timeout=5)
            self.process = None

    def is_running(self):
        if self.process and self.process.poll() is None:
            return True
        elif self.process and self.process.returncode != 0:
            logger.warning(f"Socat process terminated with exit code: {self.process.returncode}")
            return False
        else:
            return False
    