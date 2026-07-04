"""Vehicle characteristics — an RQ-180 stand-in, expressed as flight *limits*.

The RQ-180 is classified, so these are open-source estimates (gaps filled from its
sibling, the RQ-4 Global Hawk) — deliberate, swappable constants. They exist to be
*clamps* on the guidance laws: the airframe can't turn, climb, or accelerate faster
than physics + these numbers allow. Stored in SI (m, m/s) to match the wire contract.

Phase 6 exercises only the turn-rate clamp (the loiter law); speed/climb clamps are
wired up in Phase 7 when commands can change the setpoints.
"""

import math
from dataclasses import dataclass

G = 9.80665  # m/s^2


@dataclass(frozen=True)
class VehicleCharacteristics:
    cruise_speed_mps: float = 42.0
    speed_min_mps: float = 30.0
    speed_max_mps: float = 60.0
    max_accel_mps2: float = 2.0
    max_bank_deg: float = 25.0
    max_climb_mps: float = 8.0
    max_descent_mps: float = 8.0
    service_ceiling_m: float = 18_000.0

    def max_turn_rate_dps(self, speed_mps: float) -> float:
        """Coordinated-turn limit: omega = g*tan(bank)/V. Faster => wider turns."""
        v = max(speed_mps, 1.0)  # guard div-by-zero at a standstill
        return math.degrees(G * math.tan(math.radians(self.max_bank_deg)) / v)


RQ_180 = VehicleCharacteristics()
