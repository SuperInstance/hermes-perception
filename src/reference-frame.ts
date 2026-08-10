/**
 * Reference Frame — a snapshot of everything Hermes perceives at one moment.
 *
 * This is the universal data contract for the perception stack.
 * Every capture (pulse or triggered) produces one ReferenceFrame.
 * Frames are stored in the perception log, rendered as MIDI,
 * and embedded into the collective unconscious for semantic search.
 *
 * Inspired by:
 *   - slackwater-perception's PerceptionEvent (multi-track encoding)
 *   - sensor-bridge's SensorReading (normalized data contract)
 *   - vessel-agent-system's VesselState (GPS, heading, speed, bathymetry)
 *   - log-tensor's guidance-system paradigm (frames as sensor observations)
 */

// ──────────────────────────────────────────────────────────────
// Core Types
// ──────────────────────────────────────────────────────────────

/**
 * A complete perception snapshot at one point in time.
 *
 * This is what Hermes "sees" when she looks at the TZ Pro display,
 * combined with GPS, depth, and vessel state data.
 *
 * Every field is optional except timestamp and position — we always
 * know when and where we are, but the sounder might be off, there
 * might be no catches, etc.
 */
export interface ReferenceFrame {
  /** ISO 8601 timestamp */
  timestamp: string;

  /** Unique frame identifier (UUID or timestamp-based) */
  frameId: string;

  /** GPS position from NMEA $GPGGA/$GPRMC */
  position: {
    lat: number;
    lon: number;
  };

  /** Speed over ground and course over ground from NMEA $GPRMC */
  speedAndHeading: {
    sog: number; // knots
    cog: number; // degrees true
  };

  /**
   * Depth relationship — the most important data for trolling.
   *
   * The F/V EILEEN trolls gear at 51 fathoms. The "red contour line"
   * on the TZ Pro is the 51-fathom isobath. Being on the deep side
   * of it = fishable. Being on the shallow side = too shallow for gear.
   */
  depthRelationship: {
    /** Current depth beneath the boat, in fathoms */
    currentDepth: number;

    /** Gear depth — always 51 fathoms for the F/V EILEEN's trolling operation */
    gearDepth: 51;

    /**
     * True when the boat is on the deep side of the 51-fathom contour.
     * This means the gear can fish effectively without dragging bottom.
     */
    insideOperatingRange: boolean;

    /**
     * Distance to the 51-fathom line, in fathoms.
     * Positive = we're deeper than the line (safe).
     * Negative = we're shallower than the line (danger).
     * Near zero = we're on the line (edge fishing, often productive).
     */
    nearestShallow: number;
  };

  /** Low-frequency echogram data (200 kHz typical). Shows biomass. */
  sounderLowFreq?: SounderFrame;

  /** High-frequency echogram data (50 kHz typical). Shows individual targets. */
  sounderHighFreq?: SounderFrame;

  /** Things Hermes noticed in this frame */
  observations: Observation[];

  /** Interference patterns (vertical lines = nearby boat sonar) */
  interferencePatterns?: InterferenceAlert[];

  /** Catch events — fish on the gear */
  catchEvents?: CatchEvent[];

  /** Sea surface temperature from NMEA $YXMTW, if available */
  seaTemp?: number; // Celsius

  /** Wind conditions from NMEA $WIMWV, if available */
  wind?: {
    speedKnots: number;
    directionDegrees: number;
    reference: 'true' | 'apparent';
  };

  /** Frame source — how this frame was captured */
  source: 'pulse' | 'triggered' | 'catch' | 'interference' | 'manual';

  /** If triggered, the reason (human-readable) */
  triggerReason?: string;
}

/**
 * A single sounder echogram frame — one snapshot of the TZ Pro display.
 *
 * The data array is a 2D grid of intensity values representing the
 * echogram image. Row 0 = surface (or top of range), last row = bottom.
 * Each column = one ping (time step).
 *
 * This is the raw material that SounderDetector processes to find
 * fish marks, feed balls, plankton layers, etc.
 */
export interface SounderFrame {
  /**
   * 2D array of intensity values (0.0–1.0).
   * data[row][col] where row = depth bin, col = ping index.
   */
  data: number[][];

  /** Depth range displayed on the sounder, in fathoms */
  depthRange: {
    min: number;
    max: number;
  };

  /** Time range of the echogram history, in seconds */
  timeRange: {
    start: number;
    end: number;
  };

  /** Frequency label from the TZ Pro display */
  frequency: 'low' | 'high';

  /** Optional: range scale setting from the TZ Pro */
  rangeScale?: number;

  /** Optional: gain setting */
  gain?: number;
}

/**
 * A single observation — something Hermes noticed on the sounder.
 *
 * This is the semantic layer on top of raw echogram data.
 * One SounderFrame might produce many Observations.
 */
export interface Observation {
  /** What type of thing was observed */
  type:
    | 'fish_mark'      // Individual fish (arc, dot, streak on echogram)
    | 'feed_ball'      // Dense bait ball concentration
    | 'plankton_layer' // Diffuse layer (DSL or thermocline scatter)
    | 'bottom_type'    // Bottom characterization
    | 'thermocline'    // Temperature gradient line
    | 'gear_tracking'  // Trolling gear visible on sounder
    | 'interference'   // Noise pattern from other electronics
    | 'temperature_break' // SST change (from sea temp sensor, not sounder)
    | 'current_change';   // Current direction shift (from COG drift)

  /** Depth of the observation, in fathoms */
  depth: number;

  /** Signal strength / intensity (0.0–1.0) */
  intensity: number;

  /** Approximate size category */
  size?: 'small' | 'medium' | 'large';

  /** How confident Hermes is about this observation (0.0–1.0) */
  confidence: number;

  /** Human-readable description */
  description: string;

  /** Which frequency shows this observation best */
  frequency: 'low' | 'high' | 'both';

  /** Depth range if the observation spans multiple depths */
  depthRange?: {
    min: number;
    max: number;
  };

  /** Position in the echogram grid (for reanalysis) */
  echogramLocation?: {
    rowStart: number;
    rowEnd: number;
    colStart: number;
    colEnd: number;
  };
}

/**
 * Interference alert — vertical lines on the echogram.
 *
 * Vertical lines that appear and persist indicate interference from
 * another boat's sonar operating at a similar frequency. This is
 * operationally important: it can mean a competing boat is nearby.
 */
export interface InterferenceAlert {
  /** Pattern type */
  type: 'vertical_lines';

  /** How strong the interference is (0.0–1.0) */
  severity: number;

  /** What Hermes recommends doing about it */
  recommendation: 'check_radar' | 'check_outward_camera' | 'note_only';

  /** When the interference was first detected */
  timestamp: string;

  /** Which frequency is affected */
  frequency: 'low' | 'high' | 'both';

  /** Estimated bearing to interference source, if determinable */
  estimatedBearing?: number;
}

/**
 * A catch event — fish on the gear.
 *
 * May be confirmed (wire bouncing, visual confirmation) or
 * suspected (gear behavior change detected on sounder).
 */
export interface CatchEvent {
  /** Species identification */
  species: 'chum' | 'coho' | 'king' | 'pink' | 'unknown';

  /** When the catch was detected/confirmed */
  time: string;

  /** GPS position at time of catch */
  location: {
    lat: number;
    lon: number;
  };

  /** Which trolling wire (1 = port, 2 = starboard, etc.) */
  gearNumber: number;

  /** Confidence level (1.0 = visually confirmed, <1.0 = inferred) */
  confidence: number;

  /** How the catch was detected */
  detectionMethod: 'visual' | 'wire_tension' | 'sounder_gear_tracking' | 'manual';
}

// ──────────────────────────────────────────────────────────────
// Utility Functions
// ──────────────────────────────────────────────────────────────

/**
 * Create a minimal ReferenceFrame with sensible defaults.
 * Fill in the details afterwards.
 */
export function createFrame(params: {
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  depth: number;
}): ReferenceFrame {
  const gearDepth = 51;
  const insideOperatingRange = params.depth >= gearDepth;
  const nearestShallow = params.depth - gearDepth;

  return {
    timestamp: new Date().toISOString(),
    frameId: `frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    position: { lat: params.lat, lon: params.lon },
    speedAndHeading: { sog: params.sog, cog: params.cog },
    depthRelationship: {
      currentDepth: params.depth,
      gearDepth,
      insideOperatingRange,
      nearestShallow,
    },
    observations: [],
    source: 'pulse',
  };
}

/**
 * Check if two frames are close enough in time and space to be correlated.
 */
export function framesAreCorrelatable(
  a: ReferenceFrame,
  b: ReferenceFrame,
  maxTimeDiffSeconds: number = 300,
  maxDistanceM: number = 500,
): boolean {
  const timeDiff =
    Math.abs(new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()) / 1000;
  if (timeDiff > maxTimeDiffSeconds) return false;

  // Equirectangular approximation (sufficient for small distances)
  const latMean = ((a.position.lat + b.position.lat) / 2) * (Math.PI / 180);
  const dLat = a.position.lat - b.position.lat;
  const dLon = a.position.lon - b.position.lon;
  const distM =
    Math.sqrt(dLat * dLat + (dLon * Math.cos(latMean)) ** 2) * 111_000;

  return distM <= maxDistanceM;
}

/**
 * Summarize a frame for logging or display.
 */
export function summarizeFrame(frame: ReferenceFrame): string {
  const depth = frame.depthRelationship.currentDepth.toFixed(1);
  const side = frame.depthRelationship.insideOperatingRange ? 'DEEP' : 'SHALLOW';
  const fishCount = frame.observations.filter((o) => o.type === 'fish_mark').length;
  const feedBalls = frame.observations.filter((o) => o.type === 'feed_ball').length;
  const parts = [
    `${frame.timestamp}`,
    `${frame.position.lat.toFixed(4)}, ${frame.position.lon.toFixed(4)}`,
    `${depth} fm (${side})`,
    `${fishCount} marks`,
    `${feedBalls} feed balls`,
  ];
  if (frame.catchEvents && frame.catchEvents.length > 0) {
    parts.push(`${frame.catchEvents.length} CATCH`);
  }
  if (frame.interferencePatterns && frame.interferencePatterns.length > 0) {
    parts.push('INTERFERENCE');
  }
  return parts.join(' | ');
}
