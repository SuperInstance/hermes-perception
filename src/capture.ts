/**
 * Perception Capture — captures reference frames on a pulse or trigger.
 *
 * The capture system is the entry point for all perception data.
 * It runs on a pulse (default every 60 seconds) and can also be
 * triggered by the agent, the user, or system events (catch detection,
 * interference pattern, temperature break).
 *
 * Architecture:
 *   1. Pulse timer fires → captureFrame()
 *   2. Triggered event → triggerCapture(reason)
 *   3. Both paths: gather GPS, depth, sounder → build ReferenceFrame
 *   4. Frame goes to SounderDetector for pattern analysis
 *   5. Frame goes to PerceptionLog for storage
 *   6. Frame goes to PerceptionMIDI for rendering (optional)
 *   7. Frame goes to UnconsciousSync for embedding (optional)
 *
 * Integration with sensor-bridge:
 *   The capture system subscribes to sensor-bridge's normalized readings.
 *   GPS, depth, temperature, and wind data come from the NMEA →
 *   sensor-bridge normalizer → perception capture pipeline.
 *
 * Integration with vessel-agent-system:
 *   VesselState provides position, heading, speed, and bathymetry context.
 *   The capture system queries VesselState for the current pose and
 *   BathymetryGrid for depth context (nearest 51-fathom line).
 */

import {
  ReferenceFrame,
  SounderFrame,
  Observation,
  InterferenceAlert,
  CatchEvent,
  createFrame,
} from './reference-frame';
import { SounderDetector } from './sounder-detector';
import { PerceptionLog } from './perception-log';

/**
 * Configuration for the perception capture system.
 */
export interface CaptureConfig {
  /** Pulse interval in seconds (should match echogram time window) */
  pulseInterval: number;

  /** Whether to automatically run pattern detection on captures */
  autoDetect: boolean;

  /** Whether to capture sounder screenshots (requires display access) */
  captureSounder: boolean;

  /** Sounder screenshot source (display capture path or camera) */
  sounderSource?: 'display_capture' | 'ip_camera' | 'manual';

  /** Path to the TZ Pro display capture utility */
  displayCapturePath?: string;
}

export const DEFAULT_CONFIG: CaptureConfig = {
  pulseInterval: 60,
  autoDetect: true,
  captureSounder: true,
  sounderSource: 'display_capture',
};

/**
 * GPS data provider interface.
 *
 * In production, this reads from vessel-agent-system's VesselState
 * which parses NMEA 0183 sentences ($GPGGA, $GPRMC).
 */
export interface GPSProvider {
  getPosition(): { lat: number; lon: number };
  getSpeedAndHeading(): { sog: number; cog: number };
}

/**
 * Depth data provider interface.
 *
 * Reads from NMEA $SDDPT/$SDDBT through sensor-bridge.
 */
export interface DepthProvider {
  getDepthFathoms(): number;
}

/**
 * Sounder frame provider interface.
 *
 * Captures the TZ Pro display and converts it to a 2D intensity array.
 * Implementation depends on how we access the display:
 *   - Display capture (direct from the TZ Pro screen)
 *   - IP camera (pointing at the sounder)
 *   - NMEA 2000 PGN (if the sounder outputs raw echogram data)
 */
export interface SounderProvider {
  captureFrame(frequency: 'low' | 'high'): Promise<SounderFrame | null>;
}

/**
 * Optional providers for richer frames.
 */
export interface EnvironmentProvider {
  getSeaTemp?(): number;
  getWind?(): { speedKnots: number; directionDegrees: number; reference: 'true' | 'apparent' };
}

/**
 * The main perception capture system.
 *
 * Usage:
 *   const capture = new PerceptionCapture({
 *     gpsProvider: vesselStateAdapter,
 *     depthProvider: nmeaDepthAdapter,
 *     sounderProvider: tzProCaptureAdapter,
 *     log: perceptionLog,
 *     config: { pulseInterval: 60, autoDetect: true, captureSounder: true },
 *   });
 *   await capture.start();
 *   // ... runs until stop()
 *   await capture.stop();
 */
export class PerceptionCapture {
  private config: CaptureConfig;
  private gpsProvider: GPSProvider;
  private depthProvider: DepthProvider;
  private sounderProvider?: SounderProvider;
  private environmentProvider?: EnvironmentProvider;
  private detector: SounderDetector;
  private log: PerceptionLog;

  private pulseTimer: NodeJS.Timeout | null = null;
  private running = false;
  private frameCount = 0;
  private lastFrame: ReferenceFrame | null = null;

  // Statistics
  private stats = {
    totalCaptures: 0,
    pulseCaptures: 0,
    triggeredCaptures: 0,
    catchTriggers: 0,
    interferenceTriggers: 0,
    failedCaptures: 0,
  };

  constructor(params: {
    gpsProvider: GPSProvider;
    depthProvider: DepthProvider;
    sounderProvider?: SounderProvider;
    environmentProvider?: EnvironmentProvider;
    log: PerceptionLog;
    detector?: SounderDetector;
    config?: Partial<CaptureConfig>;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...params.config };
    this.gpsProvider = params.gpsProvider;
    this.depthProvider = params.depthProvider;
    this.sounderProvider = params.sounderProvider;
    this.environmentProvider = params.environmentProvider;
    this.log = params.log;
    this.detector = params.detector ?? new SounderDetector();
  }

  /**
   * Start the pulse timer.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log(
      `[PerceptionCapture] Starting pulse every ${this.config.pulseInterval}s`,
    );

    // Capture immediately on start
    await this.captureFrame();

    // Then on pulse
    this.pulseTimer = setInterval(
      () => this.captureFrame().catch((e) =>
        console.error('[PerceptionCapture] Pulse capture error:', e),
      ),
      this.config.pulseInterval * 1000,
    );
  }

  /**
   * Stop the pulse timer.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
    console.log('[PerceptionCapture] Stopped');
  }

  /**
   * Capture a reference frame on the regular pulse.
   *
   * This is the heartbeat of the perception system. Every pulse:
   *   1. Read GPS position, SOG, COG
   *   2. Read current depth
   *   3. Check depth relationship (inside/outside 51-fathom line)
   *   4. Capture sounder frames (low + high freq)
   *   5. Run pattern detection on sounder frames
   *   6. Log observations
   *   7. Check for interference patterns
   *   8. Store as ReferenceFrame
   */
  async captureFrame(): Promise<ReferenceFrame> {
    try {
      // 1-3. Get navigation data
      const pos = this.gpsProvider.getPosition();
      const { sog, cog } = this.gpsProvider.getSpeedAndHeading();
      const depth = this.depthProvider.getDepthFathoms();

      // Create the base frame
      const frame = createFrame({ lat: pos.lat, lon: pos.lon, sog, cog, depth });
      frame.source = 'pulse';

      // 4. Capture sounder frames
      if (this.config.captureSounder && this.sounderProvider) {
        try {
          frame.sounderLowFreq = await this.sounderProvider.captureFrame('low') ?? undefined;
        } catch { /* sounder might be offline */ }
        try {
          frame.sounderHighFreq = await this.sounderProvider.captureFrame('high') ?? undefined;
        } catch { /* sounder might be offline */ }
      }

      // 5. Run pattern detection
      if (this.config.autoDetect) {
        const observations: Observation[] = [];
        const interference: InterferenceAlert[] = [];

        for (const freq of ['low', 'high'] as const) {
          const sf = freq === 'low' ? frame.sounderLowFreq : frame.sounderHighFreq;
          if (!sf) continue;

          const detected = this.detector.detectAll(sf);
          observations.push(...detected.observations);

          const interf = this.detector.detectInterference(sf);
          if (interf) interference.push(interf);
        }

        // Deduplicate observations from both frequencies
        frame.observations = this.deduplicateObservations(observations);
        if (interference.length > 0) {
          frame.interferencePatterns = interference;
        }
      }

      // Environment data
      if (this.environmentProvider?.getSeaTemp) {
        frame.seaTemp = this.environmentProvider.getSeaTemp();
      }
      if (this.environmentProvider?.getWind) {
        const wind = this.environmentProvider.getWind();
        frame.wind = wind;
      }

      // 8. Store
      await this.log.log(frame);

      // Update stats
      this.frameCount++;
      this.stats.totalCaptures++;
      this.stats.pulseCaptures++;
      this.lastFrame = frame;

      return frame;
    } catch (error) {
      this.stats.failedCaptures++;
      console.error('[PerceptionCapture] Capture failed:', error);
      throw error;
    }
  }

  /**
   * Trigger a capture outside the pulse.
   *
   * Called by:
   *   - User or agent requesting a perception check
   *   - Catch event detected (wire tension, visual confirmation)
   *   - Interference pattern detected
   *   - Temperature break or current change
   */
  async triggerCapture(
    reason: string,
    source: 'triggered' | 'catch' | 'interference' | 'manual' = 'triggered',
    catchEvent?: CatchEvent,
  ): Promise<ReferenceFrame> {
    const frame = await this.captureFrame();
    frame.source = source;
    frame.triggerReason = reason;

    if (catchEvent) {
      frame.catchEvents = [catchEvent];
      this.stats.catchTriggers++;
    }

    if (source === 'interference') {
      this.stats.interferenceTriggers++;
    }

    this.stats.triggeredCaptures++;

    // Re-log with updated source/reason
    await this.log.log(frame);

    return frame;
  }

  /**
   * Get capture statistics.
   */
  getStats() {
    return {
      ...this.stats,
      frameCount: this.frameCount,
      running: this.running,
      pulseInterval: this.config.pulseInterval,
      hasLastFrame: this.lastFrame !== null,
    };
  }

  /**
   * Get the most recently captured frame.
   */
  getLastFrame(): ReferenceFrame | null {
    return this.lastFrame;
  }

  /**
   * Deduplicate observations that appear on both frequencies.
   *
   * When the same fish mark appears on both low and high freq,
   * we keep the one with higher confidence and mark it as 'both'.
   */
  private deduplicateObservations(obs: Observation[]): Observation[] {
    const deduped: Observation[] = [];
    const used = new Set<number>();

    for (let i = 0; i < obs.length; i++) {
      if (used.has(i)) continue;

      let best = obs[i];

      for (let j = i + 1; j < obs.length; j++) {
        if (used.has(j)) continue;

        // Same type, similar depth = same target
        if (
          obs[j].type === best.type &&
          Math.abs(obs[j].depth - best.depth) < 2 // within 2 fathoms
        ) {
          if (obs[j].confidence > best.confidence) {
            used.add(i);
            best = obs[j];
          } else {
            used.add(j);
          }
          best.frequency = 'both';
        }
      }

      deduped.push(best);
    }

    return deduped;
  }
}
