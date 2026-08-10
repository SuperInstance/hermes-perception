/**
 * Perception MIDI — renders sounder observations as multi-track MIDI.
 *
 * Uses slackwater-perception's MultiTrackEncoder to convert the fishing
 * grounds into music. This isn't art for art's sake — it's a different
 * sensory modality for understanding what's happening under the boat.
 *
 * The human eye processes echograms as images. The human ear processes
 * music as time + emotion + pattern. By rendering the sounder data as
 * MIDI, Hermes gets a third perspective on the fishing grounds:
 *
 *   1. Visual: the TZ Pro display (what Casey sees)
 *   2. Semantic: Observation objects (what Hermes "understands")
 *   3. Musical: MIDI rendering (what the grounds "feel like")
 *
 * Track mapping:
 *   - Pitch track: depth of fish marks → MIDI notes (deeper = lower)
 *   - Velocity track: signal intensity → volume
 *   - Timbre track: bottom type (rock = bright, mud = warm, weed = nasal)
 *   - Silence track: gaps between marks (dead zones = long rests)
 *   - Intention track: convergence patterns (feed ball forming = building)
 *   - Attention track: where biomass is concentrating
 *   - Gesture track: catch events (the climax note)
 *   - Tempo track: vessel speed (faster trolling = faster tempo)
 *   - Inflection track: depth trend (rising = shallowing, falling = deepening)
 *
 * Integration with slackwater-perception:
 *   The MultiTrackEncoder is called via the Python bridge (child process).
 *   This module prepares PerceptionEvents from ReferenceFrames and passes
 *   them to the encoder. The resulting MIDI file can be played back or
 *   analyzed.
 *
 * The result: you can LISTEN to the sounder data and hear when fish
 * are active vs scattered, when feed balls form vs dissolve, when
 * the thermocline shifts. It's a different kind of perception.
 */

import { ReferenceFrame, Observation } from './reference-frame';
import { spawn } from 'child_process';
import { join, resolve } from 'path';

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

/**
 * A MIDI rendering event derived from a perception observation.
 * This maps directly to slackwater-perception's PerceptionEvent.
 */
export interface MidiPerceptionEvent {
  tick: number;
  trackType:
    | 'pitch'
    | 'tempo'
    | 'velocity'
    | 'timbre'
    | 'inflection'
    | 'silence'
    | 'gesture'
    | 'intention'
    | 'attention';
  midiNote?: number;
  velocity?: number;
  pitchHz?: number;
  bpm?: number;
  inflection?: 'rising' | 'falling' | 'flat';
  gestureType?: 'nod' | 'look' | 'point' | 'lean' | 'breath' | 'trade' | 'hold' | 'custom';
  intensity?: number;
  intentionStrength?: number;
  attentionWeight?: number;
  timbreColor?: string;
  durationTicks: number;
  label: string;
}

/**
 * Configuration for the MIDI renderer.
 */
export interface MidiConfig {
  /** Ticks per beat (MIDI resolution) */
  ticksPerBeat: number;

  /** Default BPM */
  defaultBpm: number;

  /** Depth range for pitch mapping (fathoms) */
  pitchDepthMin: number;
  pitchDepthMax: number;

  /** MIDI note range for pitch mapping */
  pitchNoteMin: number; // for deepest depth
  pitchNoteMax: number; // for shallowest depth

  /** Path to the slackwater-perception Python encoder script */
  encoderScriptPath?: string;

  /** Python executable path */
  pythonPath?: string;
}

export const DEFAULT_MIDI_CONFIG: MidiConfig = {
  ticksPerBeat: 480,
  defaultBpm: 90, // Slow, contemplative tempo — fishing pace
  pitchDepthMin: 0,    // Surface
  pitchDepthMax: 100,  // 100 fathoms (deep)
  pitchNoteMin: 33,    // A1 — deep, resonant
  pitchNoteMax: 96,    // C7 — bright, high
  encoderScriptPath: undefined, // Set to use Python bridge
  pythonPath: 'python3',
};

// ──────────────────────────────────────────────────────────────
// Depth/MIDI conversion
// ──────────────────────────────────────────────────────────────

/**
 * Convert a depth in fathoms to a MIDI note number.
 * Deeper = lower pitch. This maps the ocean's vertical dimension
 * to the musical pitch space.
 */
export function depthToMidiNote(
  depth: number,
  config: MidiConfig = DEFAULT_MIDI_CONFIG,
): number {
  const clampedDepth = Math.max(
    config.pitchDepthMin,
    Math.min(config.pitchDepthMax, depth),
  );
  const fraction =
    (config.pitchDepthMax - clampedDepth) /
    (config.pitchDepthMax - config.pitchDepthMin);
  const note = Math.round(
    config.pitchNoteMin + fraction * (config.pitchNoteMax - config.pitchNoteMin),
  );
  return Math.max(0, Math.min(127, note));
}

/**
 * Convert signal intensity (0-1) to MIDI velocity (0-127).
 */
export function intensityToVelocity(intensity: number): number {
  return Math.max(1, Math.min(127, Math.round(intensity * 127)));
}

/**
 * Map observation type to a timbre color.
 * This determines the "instrument" character of each observation.
 */
export function observationToTimbre(obs: Observation): string {
  switch (obs.type) {
    case 'fish_mark':
      return obs.depth < 30 ? 'bright' : 'warm'; // Shallow fish = bright, deep = warm
    case 'feed_ball':
      return 'nasal'; // Dense, concentrated
    case 'plankton_layer':
      return 'breathy'; // Diffuse, ambient
    case 'bottom_type':
      if (obs.description.includes('rock') || obs.description.includes('hard')) {
        return 'bright';
      } else if (obs.description.includes('weed')) {
        return 'nasal';
      }
      return 'warm'; // soft bottom
    case 'thermocline':
      return 'cold'; // Temperature boundary = cool sound
    case 'gear_tracking':
      return 'warm'; // Gear = steady, warm
    case 'interference':
      return 'cold'; // Interference = harsh
    default:
      return 'neutral';
  }
}

// ──────────────────────────────────────────────────────────────
// Frame → MIDI Events
// ──────────────────────────────────────────────────────────────

/**
 * Convert a ReferenceFrame into MIDI perception events.
 *
 * Each frame becomes a slice of time in the MIDI rendering.
 * Multiple frames played in sequence create the full "song."
 */
export function frameToMidiEvents(
  frame: ReferenceFrame,
  startTick: number,
  ticksPerFrame: number = 480, // One beat per frame by default
  config: MidiConfig = DEFAULT_MIDI_CONFIG,
): MidiPerceptionEvent[] {
  const events: MidiPerceptionEvent[] = [];

  // ── Tempo track: vessel speed → BPM ──
  const speedBpm = Math.round(config.defaultBpm + frame.speedAndHeading.sog * 2);
  events.push({
    tick: startTick,
    trackType: 'tempo',
    bpm: speedBpm,
    durationTicks: 0,
    label: `SOG ${frame.speedAndHeading.sog.toFixed(1)} kn → ${speedBpm} BPM`,
  });

  // ── Pitch + Velocity tracks: fish marks → notes ──
  const fishMarks = frame.observations.filter((o) => o.type === 'fish_mark');
  if (fishMarks.length > 0) {
    // Sort by depth for melodic ordering
    const sorted = [...fishMarks].sort((a, b) => a.depth - b.depth);
    const noteSpacing = Math.floor(ticksPerFrame / (sorted.length + 1));

    sorted.forEach((obs, i) => {
      const tick = startTick + (i + 1) * noteSpacing;
      const note = depthToMidiNote(obs.depth, config);
      const vel = intensityToVelocity(obs.intensity);

      events.push({
        tick,
        trackType: 'pitch',
        midiNote: note,
        velocity: vel,
        pitchHz: 440 * Math.pow(2, (note - 69) / 12),
        durationTicks: noteSpacing,
        intensity: obs.intensity,
        label: `Fish mark at ${obs.depth.toFixed(0)} fm → note ${note}`,
      });

      events.push({
        tick,
        trackType: 'velocity',
        velocity: vel,
        intensity: obs.intensity,
        durationTicks: noteSpacing,
        label: `intensity=${obs.intensity.toFixed(2)}`,
      });

      events.push({
        tick,
        trackType: 'timbre',
        timbreColor: observationToTimbre(obs),
        durationTicks: noteSpacing,
        label: observationToTimbre(obs),
      });
    });
  } else {
    // Silence — no fish marks in this frame
    events.push({
      tick: startTick,
      trackType: 'silence',
      durationTicks: ticksPerFrame,
      label: 'no marks',
    });
  }

  // ── Feed balls → intention events (something is about to happen) ──
  const feedBalls = frame.observations.filter((o) => o.type === 'feed_ball');
  if (feedBalls.length > 0) {
    const strength = Math.min(
      1.0,
      feedBalls.reduce((s, fb) => s + fb.intensity, 0) / feedBalls.length,
    );
    events.push({
      tick: startTick,
      trackType: 'intention',
      intentionStrength: strength,
      durationTicks: ticksPerFrame,
      label: `Feed ball forming → bite likely`,
    });
  }

  // ── Attention track: where is the most biomass? ──
  const allObs = frame.observations;
  if (allObs.length > 0) {
    // Find the depth with the highest total intensity
    const depthMap: Record<number, number> = {};
    for (const obs of allObs) {
      const depthKey = Math.round(obs.depth / 5) * 5; // 5-fathom bins
      depthMap[depthKey] = (depthMap[depthKey] ?? 0) + obs.intensity;
    }
    const peakDepth = Object.entries(depthMap).sort(
      ([, a], [, b]) => b - a,
    )[0];
    if (peakDepth) {
      events.push({
        tick: startTick,
        trackType: 'attention',
        attentionWeight: Math.min(1.0, parseFloat(peakDepth[1]) / 3),
        durationTicks: ticksPerFrame,
        label: `attention → ${peakDepth[0]} fm`,
      });
    }
  }

  // ── Inflection track: depth trend ──
  // Rising = getting shallower (inflection up = uncertain)
  // Falling = getting deeper (inflection down = certain)
  if (frame.depthRelationship.nearestShallow > 0) {
    events.push({
      tick: startTick,
      trackType: 'inflection',
      inflection: 'falling', // Getting deeper = falling pitch
      durationTicks: ticksPerFrame,
      label: 'deepening',
    });
  } else if (frame.depthRelationship.nearestShallow < -5) {
    events.push({
      tick: startTick,
      trackType: 'inflection',
      inflection: 'rising', // Getting shallower = rising pitch
      durationTicks: ticksPerFrame,
      label: 'shallowing',
    });
  } else {
    events.push({
      tick: startTick,
      trackType: 'inflection',
      inflection: 'flat', // On the line
      durationTicks: ticksPerFrame,
      label: 'on the line',
    });
  }

  // ── Gesture track: catch events = the climax ──
  if (frame.catchEvents && frame.catchEvents.length > 0) {
    for (const catchEvent of frame.catchEvents) {
      events.push({
        tick: startTick + Math.floor(ticksPerFrame / 2),
        trackType: 'gesture',
        gestureType: 'hold', // The catch is a held note — the climax
        intensity: 1.0,
        durationTicks: ticksPerFrame,
        label: `CATCH: ${catchEvent.species} on gear ${catchEvent.gearNumber}`,
      });
    }
  }

  // ── Thermocline → sustained note ──
  const thermocline = frame.observations.find((o) => o.type === 'thermocline');
  if (thermocline) {
    const note = depthToMidiNote(thermocline.depth, config);
    events.push({
      tick: startTick,
      trackType: 'pitch',
      midiNote: note,
      velocity: 30, // Quiet, sustained
      pitchHz: 440 * Math.pow(2, (note - 69) / 12),
      durationTicks: ticksPerFrame * 2, // Holds across the frame
      timbreColor: 'cold',
      label: `Thermocline at ${thermocline.depth.toFixed(0)} fm`,
    });
  }

  return events;
}

/**
 * Render a sequence of ReferenceFrames as a MIDI file.
 *
 * This is the full "song of the fishing grounds."
 *
 * Usage:
 *   const renderer = new PerceptionMidi();
 *   await renderer.renderToFile(frames, './output/fishing-ground.mid');
 */
export class PerceptionMidi {
  private config: MidiConfig;

  constructor(config?: Partial<MidiConfig>) {
    this.config = { ...DEFAULT_MIDI_CONFIG, ...config };
  }

  /**
   * Convert frames to MIDI events.
   */
  framesToEvents(frames: ReferenceFrame[]): MidiPerceptionEvent[] {
    const allEvents: MidiPerceptionEvent[] = [];
    const ticksPerFrame = this.config.ticksPerBeat;

    frames.forEach((frame, i) => {
      const startTick = i * ticksPerFrame;
      const frameEvents = frameToMidiEvents(
        frame,
        startTick,
        ticksPerFrame,
        this.config,
      );
      allEvents.push(...frameEvents);
    });

    return allEvents;
  }

  /**
   * Render frames to a MIDI file using the slackwater-perception
   * MultiTrackEncoder (Python bridge).
   *
   * If the encoder script is not available, falls back to a
   * JSON dump of the events.
   */
  async renderToFile(
    frames: ReferenceFrame[],
    outputPath: string,
  ): Promise<string> {
    const events = this.framesToEvents(frames);

    if (this.config.encoderScriptPath) {
      // Python bridge: call slackwater-perception's encoder
      try {
        const scriptPath = resolve(this.config.encoderScriptPath);
        const result = await this.callPythonEncoder(events, outputPath, scriptPath);
        console.log(`[PerceptionMidi] Rendered ${frames.length} frames to ${outputPath}`);
        return result;
      } catch (error) {
        console.warn('[PerceptionMidi] Python encoder failed, falling back to JSON:', error);
      }
    }

    // Fallback: write events as JSON
    const jsonPath = outputPath.replace(/\.mid$/, '.json');
    const { writeFileSync } = require('fs');
    writeFileSync(jsonPath, JSON.stringify({
      config: this.config,
      frameCount: frames.length,
      events,
      renderedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`[PerceptionMidi] Wrote ${events.length} events to ${jsonPath}`);
    return jsonPath;
  }

  /**
   * Get a summary of what the MIDI rendering sounds like.
   * Useful for display alongside the audio.
   */
  describeRendering(frames: ReferenceFrame[]): string {
    const events = this.framesToEvents(frames);
    const pitchEvents = events.filter((e) => e.trackType === 'pitch');
    const silenceEvents = events.filter((e) => e.trackType === 'silence');
    const catchEvents = events.filter((e) =>
      e.trackType === 'gesture' && e.label.startsWith('CATCH'),
    );
    const intentionEvents = events.filter((e) => e.trackType === 'intention');

    const notes = pitchEvents.filter((e) => e.midiNote !== undefined);
    const noteRange = notes.length > 0
      ? `${Math.min(...notes.map((e) => e.midiNote!))}-${Math.max(...notes.map((e) => e.midiNote!))}`
      : 'none';

    const parts = [
      `${frames.length} frames`,
      `${pitchEvents.length} notes (range: ${noteRange})`,
      `${silenceEvents.length} silence periods`,
      `${intentionEvents.length} intention signals`,
    ];

    if (catchEvents.length > 0) {
      parts.push(`${catchEvents.length} CATCH moments`);
    }

    return parts.join(', ');
  }

  /**
   * Call the slackwater-perception Python encoder.
   */
  private async callPythonEncoder(
    events: MidiPerceptionEvent[],
    outputPath: string,
    scriptPath: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const python = spawn(this.config.pythonPath!, [
        scriptPath,
        '--output', outputPath,
        '--events', JSON.stringify(events),
        '--ticks-per-beat', String(this.config.ticksPerBeat),
        '--bpm', String(this.config.defaultBpm),
      ]);

      let stderr = '';
      python.stderr.on('data', (data) => { stderr += data; });
      python.on('error', reject);
      python.on('close', (code) => {
        if (code === 0) resolve(outputPath);
        else reject(new Error(`Python encoder exited ${code}: ${stderr}`));
      });
    });
  }
}
