"""Server-side flight model: one stateful uav-01 that flies a loiter around CENTER.

Phase 6: the sim is no longer a pure function of time. `VehicleSim` *carries state*
(position, heading, speed) and integrates it forward one fixed step at a time, so a
command can later change the future trajectory (Phase 7). The default guidance is a
LOITER law — steer along the tangent of a circle, nudging back onto the ring — which
reproduces the old circle as its *steady state* rather than as a scripted path.

There is exactly ONE VehicleSim, stepped by one clock (main.py's sim loop). A stateless
`telemetry_at(t)` gave every client a consistent world for free; a stateful sim would
diverge per-connection, so the world must be a single shared instance.
"""

import math
import time

from schemas import Attitude, Command, Geozone, Position, SnapshotMsg, Status, TelemetryMsg, VehicleState, Velocity
from vehicle import G, RQ_180, VehicleCharacteristics

CENTER_LNG = -77.0365
CENTER_LAT = 38.8977
M_PER_DEG_LAT = 111_320.0
RADIUS_DEG = 0.02  # ~2.2 km, unchanged from the Phase 2 circle
LOITER_RADIUS_M = RADIUS_DEG * M_PER_DEG_LAT
CRUISE_ALT_M = 500.0
LOITER_DIR = -1  # -1 = CCW (matches the old circle's direction), +1 = CW
K_RADIUS = 1.0  # radius-capture gain: how hard we steer back onto the ring


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _wrap180(deg: float) -> float:
    """Shortest signed angle in [-180, 180)."""
    return (deg + 180.0) % 360.0 - 180.0


def _offsets_m(lat1: float, lng1: float, lat2: float, lng2: float) -> tuple[float, float]:
    """North/east offset (metres) from p1 to p2 (equirectangular; fine at this scale)."""
    north = (lat2 - lat1) * M_PER_DEG_LAT
    east = (lng2 - lng1) * M_PER_DEG_LAT * math.cos(math.radians(lat1))
    return north, east


class VehicleSim:
    """A single point-mass aircraft flying a loiter, integrated at a fixed timestep."""

    def __init__(self, vehicle_id: str = "uav-01", veh: VehicleCharacteristics = RQ_180) -> None:
        self.vehicle_id = vehicle_id
        self.veh = veh
        # --- integrated state ---
        self.lat = CENTER_LAT
        # start ON the ring, due east of center, so the initial track matches the old circle
        self.lng = CENTER_LNG + RADIUS_DEG / math.cos(math.radians(CENTER_LAT))
        self.alt_m = CRUISE_ALT_M
        self.heading_deg = 0.0  # compass heading (0=N, 90=E); set to the tangent below
        self.speed_mps = veh.cruise_speed_mps
        self.roll_deg = 0.0  # derived each step, for display
        self.battery_pct = 100.0
        # --- loiter setpoints ---
        self.mode = "LOITER"
        self.loiter_lat = CENTER_LAT
        self.loiter_lng = CENTER_LNG
        self.loiter_radius_m = LOITER_RADIUS_M
        self.loiter_dir = LOITER_DIR
        self.pitch_deg = 0.0  # derived from vertical speed, for display
        # Face the loiter tangent for whichever direction we start in, so CW and CCW
        # both capture the ring immediately instead of slewing ~180deg to reverse.
        self.heading_deg = self._loiter_heading()
        # --- HSA setpoints (tracked when mode == "HSA") ---
        self.tgt_heading_deg = self.heading_deg
        self.tgt_speed_mps = self.speed_mps
        self.tgt_alt_m = self.alt_m

    # ---- command intake: validate against the envelope, then set mode + setpoints ----
    def apply(self, command: Command) -> tuple[bool, str | None]:
        """The server owns the truth: a command only sets *intent*. Returns (accepted, reason)."""
        if command.kind == "hsa":
            if command.speedMps is not None and not (
                self.veh.speed_min_mps <= command.speedMps <= self.veh.speed_max_mps
            ):
                return False, f"speed {command.speedMps:.0f} outside [{self.veh.speed_min_mps:.0f}, {self.veh.speed_max_mps:.0f}] m/s"
            if command.altM is not None and not (0.0 <= command.altM <= self.veh.service_ceiling_m):
                return False, f"altitude {command.altM:.0f} outside [0, {self.veh.service_ceiling_m:.0f}] m"
            self.mode = "HSA"
            # Heading has no persistent setpoint during LOITER (it's recomputed each
            # tick), so an omitted heading means "hold the CURRENT heading", not reuse a
            # stale value. Speed/alt setpoints stay live across modes, so keep theirs.
            self.tgt_heading_deg = command.headingDeg % 360.0 if command.headingDeg is not None else self.heading_deg
            if command.speedMps is not None:
                self.tgt_speed_mps = command.speedMps
            if command.altM is not None:
                self.tgt_alt_m = command.altM
            return True, None

        # loiter: resolve "keep current" fields, validate, THEN commit (never half-apply)
        center_lng = command.centerLng if command.centerLng is not None else self.lng
        center_lat = command.centerLat if command.centerLat is not None else self.lat
        radius_m = command.radiusM if command.radiusM is not None else self.loiter_radius_m
        direction = {"cw": 1, "ccw": -1}[command.direction] if command.direction is not None else self.loiter_dir
        # Feasibility against the speed the loiter will actually be FLOWN at (tgt_speed),
        # not the instantaneous speed — mid-accel the two differ and the ring must hold at
        # the settled speed. r_min = V^2 / (g*tan(bank_max)).
        r_min = self.tgt_speed_mps**2 / (G * math.tan(math.radians(self.veh.max_bank_deg)))
        if radius_m < r_min:
            return False, f"radius {radius_m:.0f} m < min turn radius {r_min:.0f} m at {self.tgt_speed_mps:.0f} m/s"
        if command.altM is not None and not (0.0 <= command.altM <= self.veh.service_ceiling_m):
            return False, f"altitude {command.altM:.0f} outside [0, {self.veh.service_ceiling_m:.0f}] m"
        self.mode = "LOITER"
        self.loiter_lng = center_lng
        self.loiter_lat = center_lat
        self.loiter_radius_m = radius_m
        self.loiter_dir = direction
        if command.altM is not None:
            self.tgt_alt_m = command.altM
        return True, None

    # ---- one fixed-timestep tick: guidance -> control -> integrate ----
    def step(self, dt: float) -> None:
        self._track_heading(self._guidance_heading(), dt)  # lateral: slew to desired heading, derive roll
        self._track_speed(dt)  # longitudinal: ramp toward target speed under the accel clamp
        self._track_altitude(dt)  # vertical: capture target altitude under the climb/descent clamp
        self._integrate_position(dt)  # dynamics: move along heading at ground speed
        self.battery_pct = max(0.0, self.battery_pct - 0.01 * dt)

    def _guidance_heading(self) -> float:
        """Both modes drive the SAME heading controller; only the setpoint source differs.
        HSA holds a fixed commanded heading; LOITER regenerates it each tick (the tangent)."""
        if self.mode == "LOITER":
            return self._loiter_heading()
        return self.tgt_heading_deg

    def _loiter_heading(self) -> float:
        """Steer along the circle's tangent, plus a term that captures the ring radius."""
        north, east = _offsets_m(self.loiter_lat, self.loiter_lng, self.lat, self.lng)
        bearing = math.degrees(math.atan2(east, north)) % 360.0  # center -> vehicle
        rng = math.hypot(north, east)
        tangent = bearing + self.loiter_dir * 90.0
        # radius capture: if we've drifted off the ring, steer back onto it.
        correction = self.loiter_dir * K_RADIUS * math.degrees(math.atan((rng - self.loiter_radius_m) / self.loiter_radius_m))
        return (tangent + correction) % 360.0

    def _track_heading(self, desired_deg: float, dt: float) -> None:
        err = _wrap180(desired_deg - self.heading_deg)
        max_step = self.veh.max_turn_rate_dps(self.speed_mps) * dt  # bank-limited turn this tick
        step_deg = _clamp(err, -max_step, max_step)
        self.heading_deg = (self.heading_deg + step_deg) % 360.0
        # display bank from the turn rate actually flown: roll = atan(omega*V/g)
        turn_rate = math.radians(step_deg / dt)  # rad/s
        self.roll_deg = math.degrees(math.atan(turn_rate * self.speed_mps / G))

    def _track_speed(self, dt: float) -> None:
        max_dv = self.veh.max_accel_mps2 * dt
        self.speed_mps += _clamp(self.tgt_speed_mps - self.speed_mps, -max_dv, max_dv)

    def _track_altitude(self, dt: float) -> None:
        dalt = _clamp(self.tgt_alt_m - self.alt_m, -self.veh.max_descent_mps * dt, self.veh.max_climb_mps * dt)
        self.alt_m += dalt
        vs = dalt / dt  # vertical speed this tick -> flight-path angle for display
        self.pitch_deg = math.degrees(math.asin(_clamp(vs / max(self.speed_mps, 1.0), -1.0, 1.0)))

    def _integrate_position(self, dt: float) -> None:
        dist = self.speed_mps * dt  # metres this tick (forward Euler)
        h = math.radians(self.heading_deg)
        # metres / (metres-per-degree) is already degrees — no math.degrees() here.
        self.lat += (dist * math.cos(h)) / M_PER_DEG_LAT
        self.lng += (dist * math.sin(h)) / (M_PER_DEG_LAT * math.cos(math.radians(self.lat)))

    # ---- outputs: identical wire shapes to the old telemetry_at/snapshot_at ----
    def telemetry(self) -> TelemetryMsg:
        return TelemetryMsg(
            ts=int(time.time() * 1000),
            vehicleId=self.vehicle_id,
            position=Position(lng=self.lng, lat=self.lat, altM=self.alt_m),
            attitude=Attitude(yawDeg=self.heading_deg, pitchDeg=self.pitch_deg, rollDeg=self.roll_deg),
            velocity=Velocity(groundSpeedMps=self.speed_mps),
            status=Status(mode=self.mode, batteryPct=self.battery_pct),
        )

    def snapshot(self) -> SnapshotMsg:
        t = self.telemetry()
        vehicle = VehicleState(
            vehicleId=t.vehicleId,
            position=t.position,
            attitude=t.attitude,
            velocity=t.velocity,
            status=t.status,
        )
        return SnapshotMsg(ts=t.ts, vehicles=[vehicle], geozones=GEOZONES)


# Mission data (cold): served in the snapshot so a late joiner sees zones it would
# otherwise miss — they aren't in the telemetry stream.
GEOZONES = [
    Geozone(
        name="R-1 Restricted",
        polygon=[
            (-77.075, 38.875),
            (-77.0, 38.875),
            (-77.0, 38.92),
            (-77.075, 38.92),
            (-77.075, 38.875),
        ],
    ),
]
