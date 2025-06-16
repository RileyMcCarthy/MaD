from . import logger
import asyncio
from .Async import AsyncHandler
from . import sim_loop, GPIO
import struct

#might wanna encoder pwm as data...
# issue is we have 2 types: software pwm and hardware pwm
# could configure the software to just send 1's every period
# and for fast pwm we send send bytes to the hardware pwm
# with the duty cycle encoded if we know the baud
# 
class ServoStep(AsyncHandler):
    def __init__(self):
        super().__init__()
        self.steps = 0
    def rx(self, data: bytes):
        logger.info(f"ServoStep: {self.steps}")
        super().step()

class ServoDirection(AsyncHandler):
    def __init__(self):
        super().__init__()
        self.direction = 0
    def rx(self, data: bytes):
        self.direction = data[0]

class Servo():
    def __init__(self, step: GPIO, direction: GPIO, enc_a: GPIO, enc_b: GPIO, endstop: GPIO):
        super().__init__()
        self.steps = 0
        self.lastSteps = 0
        self.direction = 0
        step.set_rx_callback(self.increment_steps)
        direction.set_rx_callback(self.set_direction)
        self.enc_a = enc_a
        self.enc_b = enc_b
        self.endstop = endstop

    def increment_steps(self, steps: bytes):
        for step in steps:
            if self.direction:
                self.steps -= step
                self.enc_a.set_state(0)
                self.enc_b.set_state(step)
            else:
                self.steps += step
                self.enc_a.set_state(step)
                self.enc_b.set_state(0)
        # this doesnt seem to work if number is not 0
        if (self.lastSteps > -812000) and (self.steps <= -812000):
            print("Endstop triggered")
            self.endstop.set_state(1)
        elif (self.lastSteps <= -812000) and (self.steps > -812000):
            print("Endstop released")
            self.endstop.set_state(0)
        self.lastSteps = self.steps
        #print(f"Servo: {self.steps}")

    def set_direction(self, dir):
        self.direction = dir[0]

    def get_position_steps(self):
        return self.steps
    
    def get_direction(self):
        return self.direction