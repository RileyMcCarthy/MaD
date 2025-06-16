# TestSample.py
from .Servo import Servo
from .ForceGauge import SimulatedADS122U04

class TestSample:
    def __init__(self, servo: Servo, force_gauge: SimulatedADS122U04):
        self.servo = servo
        self.force_gauge = force_gauge

    def apply_force(self):
        position = self.servo.get_position_steps()
        force = self.calculate_force(position)
        self.force_gauge.set_force(force)

    def calculate_force(self, position: int) -> float:
        # Example calculation, you can replace this with your actual force calculation logic
        return (position / 8192)