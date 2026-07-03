"""Server-side flight simulator: uav-01 flies a circle around CENTER.

Mirrors the Phase 2 browser driver but emits the wire `TelemetryMsg` shape. Position
is a pure function of elapsed time, so the world is consistent for any client.
"""

import math

from schemas import Attitude, Position, TelemetryMsg, Velocity

CENTER_LNG = -77.0365
CENTER_LAT = 38.8977
RADIUS_DEG = 0.02  # ~2.2 km
PERIOD_S = 20.0  # one lap
GROUND_SPEED_MPS = 42.0


def telemetry_at(elapsed_s: float, ts_ms: int, vehicle_id: str = "uav-01") -> TelemetryMsg:
    theta_deg = (elapsed_s / PERIOD_S * 360.0) % 360.0
    theta = math.radians(theta_deg)
    # cos(lat) keeps the circle round despite mercator longitude compression.
    lng = CENTER_LNG + (RADIUS_DEG * math.cos(theta)) / math.cos(math.radians(CENTER_LAT))
    lat = CENTER_LAT + RADIUS_DEG * math.sin(theta)
    # Heading = compass bearing of the tangent (CCW motion, so heading = -theta).
    heading_deg = (360.0 - theta_deg) % 360.0
    return TelemetryMsg(
        ts=ts_ms,
        vehicleId=vehicle_id,
        position=Position(lng=lng, lat=lat),
        attitude=Attitude(yawDeg=heading_deg),
        velocity=Velocity(groundSpeedMps=GROUND_SPEED_MPS),
    )
