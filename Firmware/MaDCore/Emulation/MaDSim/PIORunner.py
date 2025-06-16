import subprocess
import threading
import logging
from time import sleep
from . import logger

class FirmwareRunner:
    def __init__(self, env: str, directory: str):
        self.directory = directory
        self.env = env
        self.running = False
        self.c_process = None
        self.monitor_thread = None
    
    def _read_output(self, process):
        while self.running:
            output = process.stdout.readline()
            if output == '' and process.poll() is not None:
                logger.error('Program has exited')
                break
            if output:
                logger.info("FIRMWARE - " + output.strip() + "\x1b[0m")
        process.kill()
        self.running = False

    def build(self):
        try:
            subprocess.check_call(['pio', 'run', '-e', self.env, '--project-dir', self.directory])
        except subprocess.CalledProcessError:
            # There was an error - command exited with non-zero code
            logger.error("Error building firmware")
            exit(1)
    
    def clean(self):
        try:
            subprocess.check_call(['pio', 'run', '-t', 'clean', '--project-dir', self.directory])
        except subprocess.CalledProcessError:
            # There was an error - command exited with non-zero code
            logger.error("Error cleaning firmware")
            exit(1)
    
    def run(self):
        # Start the C program as a subprocess
        if self.running:
            self.stop()
        self.running = True
        self.c_process = subprocess.Popen(f'{self.directory}/.pio/build/{self.env}/program', stdout=subprocess.PIPE, stderr=subprocess.STDOUT, shell=True, universal_newlines=True)

        # Create a thread to continuously read and print the output
        self.monitor_thread = threading.Thread(target=self._read_output, args=(self.c_process,))
        self.monitor_thread.start()
    
    def stop(self):
        self.running = False
        if self.c_process is not None:
            self.c_process.kill()
            self.c_process = None
        if self.monitor_thread is not None:
            self.monitor_thread.join()
            self.monitor_thread = None
        logger.info("Firmware stopped")
        
    def is_running(self):
        return self.running
        