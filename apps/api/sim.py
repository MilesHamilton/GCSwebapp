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

from schemas import Attitude, Command, Position, Status, TelemetryMsg, VehicleState, Velocity
from vehicle import G, RQ_180, VehicleCharacteristics

M_PER_DEG_LAT = 111_320.0

# Ronald Reagan Washington National (KDCA), runway 1/19 (main runway) — published
# threshold positions (AirNav). The vehicle starts on RWY 01; the loiter + geozone
# are centred on the airport.
RWY01_LNG, RWY01_LAT = -77.0374485, 38.8415817  # RWY 01 threshold (south end)
RWY19_LNG, RWY19_LAT = -77.0388737, 38.8611926  # RWY 19 threshold (north end)
RWY_BEARING_DEG = 357.0  # RWY 01 departure heading (true), ~due north
CENTER_LNG = (RWY01_LNG + RWY19_LNG) / 2.0  # runway midpoint = loiter center
CENTER_LAT = (RWY01_LAT + RWY19_LAT) / 2.0

RADIUS_DEG = 0.02  # ~2.2 km loiter ring
LOITER_RADIUS_M = RADIUS_DEG * M_PER_DEG_LAT
CRUISE_ALT_M = 500.0
LOITER_DIR = -1  # -1 = CCW, +1 = CW
K_RADIUS = 1.0  # radius-capture gain: how hard we steer back onto the ring
RACETRACK_SEG_M = 25.0  # racetrack polyline resolution
RACETRACK_LOOKAHEAD_M = 120.0  # pure-pursuit carrot distance ahead on the path
WP_CAPTURE_M = 150.0  # waypoint hit radius: within this, advance to the next waypoint


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


def _local_to_lnglat(clat: float, clng: float, east_m: float, north_m: float) -> list[float]:
    lat = clat + north_m / M_PER_DEG_LAT
    lng = clng + east_m / (M_PER_DEG_LAT * math.cos(math.radians(clat)))
    return [lng, lat]


def _build_racetrack_path(
    clat: float, clng: float, semi_major: float, semi_minor: float, bearing_deg: float, direction: str
) -> list[list[float]]:
    """Stadium/racetrack as a closed [lng,lat] polyline: two straight legs joined by two
    180deg turns. semi_minor = turn radius; leg length L = 2*(semi_major - semi_minor)."""
    r = semi_minor
    leg = max(0.0, 2.0 * (semi_major - semi_minor))
    br = math.radians(bearing_deg)
    ue, un = math.sin(br), math.cos(br)  # unit vector along the long axis (east, north)
    we, wn = math.cos(br), -math.sin(br)  # unit vector to its right

    def uw(pu: float, pw: float) -> list[float]:  # local (along, right) metres -> [lng,lat]
        return _local_to_lnglat(clat, clng, pu * ue + pw * we, pu * un + pw * wn)

    half = leg / 2.0
    n_leg = max(1, int(leg / RACETRACK_SEG_M))
    n_arc = max(4, int(math.pi * r / RACETRACK_SEG_M))
    pts: list[list[float]] = []
    for i in range(n_leg):  # leg 1: right side, back -> front
        pts.append(uw(-half + leg * i / n_leg, r))
    for i in range(n_arc):  # turn 1 at +half: (0,+r) -> bulge +u -> (0,-r)
        phi = math.pi * i / n_arc
        pts.append(uw(half + r * math.sin(phi), r * math.cos(phi)))
    for i in range(n_leg):  # leg 2: left side, front -> back
        pts.append(uw(half - leg * i / n_leg, -r))
    for i in range(n_arc):  # turn 2 at -half: (0,-r) -> bulge -u -> (0,+r)
        phi = math.pi * i / n_arc
        pts.append(uw(-half - r * math.sin(phi), -r * math.cos(phi)))
    if direction == "cw":
        pts.reverse()
    return pts


class VehicleSim:
    """A single point-mass aircraft flying a loiter, integrated at a fixed timestep."""

    def __init__(
        self,
        vehicle_id: str = "uav-01",
        veh: VehicleCharacteristics = RQ_180,
        *,
        start_lat: float = RWY01_LAT,
        start_lng: float = RWY01_LNG,
        start_heading_deg: float = RWY_BEARING_DEG,
        start_alt_m: float = CRUISE_ALT_M,
        loiter_lat: float = CENTER_LAT,
        loiter_lng: float = CENTER_LNG,
    ) -> None:
        self.vehicle_id = vehicle_id
        self.veh = veh
        # --- integrated state --- start pose (defaults = DCA RWY 01, heading down the
        # runway); the default loiter then captures it into an orbit around loiter_lat/lng.
        # A fleet passes distinct poses + loiter centers so the aircraft don't converge on
        # one ring (the '2-3 distinct aircraft' criterion).
        self.lat = start_lat
        self.lng = start_lng
        self.alt_m = start_alt_m
        self.heading_deg = start_heading_deg  # compass heading (0=N, 90=E)
        self.speed_mps = veh.cruise_speed_mps
        self.roll_deg = 0.0  # derived each step, for display
        self.battery_pct = 100.0
        # --- loiter setpoints (default guidance: orbit the loiter center) ---
        self.mode = "LOITER"
        self.loiter_lat = loiter_lat
        self.loiter_lng = loiter_lng
        self.loiter_radius_m = LOITER_RADIUS_M
        self.loiter_dir = LOITER_DIR
        self.pitch_deg = 0.0  # derived from vertical speed, for display
        # --- HSA setpoints (tracked when mode == "HSA") ---
        self.tgt_heading_deg = self.heading_deg
        self.tgt_speed_mps = self.speed_mps
        self.tgt_alt_m = self.alt_m
        # --- racetrack path, [lng,lat] polyline (built when a racetrack command lands) ---
        self.rt_path: list[list[float]] = []
        # --- waypoint mission: operator-placed 3D route, flown in order and looped ---
        self.wp_path: list[Position] = []
        self.wp_index = 0

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

        if command.kind == "racetrack":
            r = command.semiMinorM  # turn radius
            r_min = self.tgt_speed_mps**2 / (G * math.tan(math.radians(self.veh.max_bank_deg)))
            if r < r_min:
                return False, f"turn radius (semi-minor) {r:.0f} m < min {r_min:.0f} m at {self.tgt_speed_mps:.0f} m/s"
            if command.semiMajorM < r:
                return False, f"semi-major {command.semiMajorM:.0f} m < semi-minor {r:.0f} m (need semi-major >= semi-minor)"
            if command.altM is not None and not (0.0 <= command.altM <= self.veh.service_ceiling_m):
                return False, f"altitude {command.altM:.0f} outside [0, {self.veh.service_ceiling_m:.0f}] m"
            center_lat = command.centerLat if command.centerLat is not None else self.lat
            center_lng = command.centerLng if command.centerLng is not None else self.lng
            bearing = command.bearingDeg if command.bearingDeg is not None else self.heading_deg
            direction = command.direction if command.direction is not None else ("cw" if self.loiter_dir == 1 else "ccw")
            self.mode = "RACETRACK"
            self.rt_path = _build_racetrack_path(center_lat, center_lng, command.semiMajorM, r, bearing, direction)
            if command.altM is not None:
                self.tgt_alt_m = command.altM
            return True, None

        if command.kind == "mission":
            if len(command.waypoints) < 2:
                return False, "mission needs at least 2 waypoints"
            for wp in command.waypoints:
                if not (0.0 <= wp.altM <= self.veh.service_ceiling_m):
                    return False, f"waypoint altitude {wp.altM:.0f} outside [0, {self.veh.service_ceiling_m:.0f}] m"
            self.mode = "WAYPOINT"
            self.wp_path = list(command.waypoints)
            self.wp_index = 0
            self.tgt_alt_m = command.waypoints[0].altM
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
        if self.mode == "RACETRACK":
            return self._racetrack_heading()
        if self.mode == "WAYPOINT":
            return self._waypoint_heading()
        if self.mode == "LOITER":
            return self._loiter_heading()
        return self.tgt_heading_deg

    def _racetrack_heading(self) -> float:
        """Pure-pursuit path follower: steer toward a carrot point a fixed lookahead ahead
        of the nearest point on the racetrack polyline (reuses the heading loop like loiter)."""
        path = self.rt_path
        if len(path) < 2:
            return self.heading_deg
        best_i, best_d = 0, math.inf
        for i, p in enumerate(path):
            d = (p[0] - self.lng) ** 2 + (p[1] - self.lat) ** 2
            if d < best_d:
                best_d, best_i = d, i
        lookahead = max(1, round(RACETRACK_LOOKAHEAD_M / RACETRACK_SEG_M))
        carrot = path[(best_i + lookahead) % len(path)]
        north, east = _offsets_m(self.lat, self.lng, carrot[1], carrot[0])
        return math.degrees(math.atan2(east, north)) % 360.0

    def _waypoint_heading(self) -> float:
        """Steer straight at the current waypoint; when captured (within WP_CAPTURE_M),
        advance to the next one, looping back to the first at the end of the route. Also
        sets the altitude target to the active waypoint so the craft flies the 3D path."""
        path = self.wp_path
        if not path:
            return self.heading_deg
        tgt = path[self.wp_index]
        north, east = _offsets_m(self.lat, self.lng, tgt.lat, tgt.lng)
        if math.hypot(north, east) < WP_CAPTURE_M and len(path) > 1:
            self.wp_index = (self.wp_index + 1) % len(path)
            tgt = path[self.wp_index]
            north, east = _offsets_m(self.lat, self.lng, tgt.lat, tgt.lng)
        self.tgt_alt_m = tgt.altM
        return math.degrees(math.atan2(east, north)) % 360.0

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

    def state(self) -> VehicleState:
        """Current vehicle state, no type/ts — the producer's register-handshake payload
        (and what the gateway caches to build snapshots). Reuses telemetry()'s projection."""
        t = self.telemetry()
        return VehicleState(
            vehicleId=t.vehicleId,
            position=t.position,
            attitude=t.attitude,
            velocity=t.velocity,
            status=t.status,
        )
