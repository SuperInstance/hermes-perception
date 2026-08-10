/**
 * Hermes Perception Stack — entry point and exports.
 *
 * This is the wiring layer that connects four existing systems:
 *   - slackwater-perception (MIDI encoding of perception)
 *   - sensor-bridge (normalized sensor data pipeline)
 *   - vessel-agent-system (AELMA vessel state, NMEA, bathymetry)
 *   - collective-unconscious (semantic embeddings + JEPA prediction)
 *
 * Hermes reads the TZ Pro sounder display on the F/V EILEEN.
 * This stack gives her the tools to do it properly.
 */

// Core types
export { ReferenceFrame, SounderFrame, Observation, InterferenceAlert, CatchEvent,
         createFrame, summarizeFrame, framesAreCorrelatable } from './reference-frame';

// Capture system
export { PerceptionCapture, CaptureConfig, DEFAULT_CONFIG as DEFAULT_CAPTURE_CONFIG,
         GPSProvider, DepthProvider, SounderProvider, EnvironmentProvider } from './capture';

// Sounder pattern detection
export { SounderDetector, DetectorConfig, DEFAULT_DETECTOR_CONFIG } from './sounder-detector';

// Perception log (SQLite)
export { PerceptionLog, QueryParams, LogEntry, CatchCorrelationResult } from './perception-log';

// MIDI rendering
export { PerceptionMidi, MidiConfig, DEFAULT_MIDI_CONFIG,
         frameToMidiEvents, depthToMidiNote, intensityToVelocity,
         observationToTimbre } from './perception-midi';

// Collective unconscious sync
export { UnconsciousSync, UnconsciousConfig, DEFAULT_UNCONSCIOUS_CONFIG,
         EmbeddedFrame, FrameFeatures, SimilarFrameResult, JEPAPrediction,
         frameToDescription, extractFeatures } from './unconscious-sync';

// The Tap bridge — connects Hermes's perception to The Tap's living agents
export { TapBridge, TapBridgeConfig, DEFAULT_TAP_BRIDGE_CONFIG,
         TapReaction, TapQuery, HermesQueryResponse,
         attachToCapture } from './tap-bridge';

// Version
export const VERSION = '1.0.0';

/**
 * Initialize the full perception stack.
 *
 * This creates all components with sensible defaults and wires them together.
 * Override any provider with your own implementation for production use.
 *
 * Usage:
 *   import { createPerceptionStack } from 'hermes-perception';
 *   const stack = await createPerceptionStack({ dbPath: './data/perception.db' });
 *   await stack.capture.start();
 */
export async function createPerceptionStack(options?: {
  dbPath?: string;
  pulseInterval?: number;
  sounderSource?: 'display_capture' | 'ip_camera' | 'manual';
  embeddingEndpoint?: string;
  vectorStoreEndpoint?: string;
  enableTapBridge?: boolean;
  tapBridgeConfig?: Partial<import('./tap-bridge').TapBridgeConfig>;
}) {
  const { PerceptionLog } = require('./perception-log');
  const { PerceptionCapture, DEFAULT_CAPTURE_CONFIG } = require('./capture');
  const { SounderDetector } = require('./sounder-detector');
  const { UnconsciousSync } = require('./unconscious-sync');
  const { PerceptionMidi } = require('./perception-midi');

  const log = new PerceptionLog(options?.dbPath ?? './data/perception.db');
  await log.init();

  const detector = new SounderDetector();
  const unconscious = new UnconsciousSync({
    embeddingEndpoint: options?.embeddingEndpoint,
    vectorStoreEndpoint: options?.vectorStoreEndpoint,
  });
  await unconscious.init();

  const midi = new PerceptionMidi();

  // Placeholder providers — replace with real implementations
  const capture = new PerceptionCapture({
    gpsProvider: {
      getPosition: () => ({ lat: 0, lon: 0 }), // Replace with vessel-agent-system adapter
      getSpeedAndHeading: () => ({ sog: 0, cog: 0 }),
    },
    depthProvider: {
      getDepthFathoms: () => 0, // Replace with NMEA depth adapter
    },
    log,
    detector,
    config: {
      pulseInterval: options?.pulseInterval ?? DEFAULT_CAPTURE_CONFIG.pulseInterval,
      captureSounder: false, // Enable when sounder provider is ready
    },
  });

  // Optionally wire The Tap bridge
  let tapBridge: import('./tap-bridge').TapBridge | null = null;
  if (options?.enableTapBridge) {
    const { TapBridge, attachToCapture } = require('./tap-bridge') as typeof import('./tap-bridge');
    tapBridge = new TapBridge(options?.tapBridgeConfig);
    await tapBridge.start();
    attachToCapture(capture, tapBridge);
  }

  return { capture, log, detector, unconscious, midi, tapBridge };
}
