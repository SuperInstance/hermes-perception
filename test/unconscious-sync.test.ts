/**
 * Hermes Perception — Unconscious Sync Logic Tests
 *
 * Tests the pure functions: frameToDescription and extractFeatures.
 * These convert a ReferenceFrame into human-readable text and
 * structured ML features respectively.
 */

import { describe, it, expect } from 'vitest';
import { frameToDescription, extractFeatures } from '../src/unconscious-sync';
import type { ReferenceFrame, Observation } from '../src/reference-frame';

function makeFrame(overrides: Partial<ReferenceFrame> = {}): ReferenceFrame {
  return {
    timestamp: '2026-08-10T10:00:00Z',
    frameId: 'test-frame',
    position: { lat: 58.3, lon: -149.5 },
    speedAndHeading: { sog: 5.5, cog: 180 },
    depthRelationship: {
      currentDepth: 51,
      gearDepth: 51,
      insideOperatingRange: true,
      redContourDepth: 51,
      depthOffset: 0,
      nearestShallow: 0,
    },
    observations: [],
    source: 'test',
    ...overrides,
  } as ReferenceFrame;
}

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    type: 'fish_mark',
    depth: 35,
    intensity: 0.7,
    confidence: 0.8,
    description: 'test fish',
    frequency: 'high',
    ...overrides,
  };
}

// ── frameToDescription ───────────────────────────────────────

describe('frameToDescription', () => {
  it('should describe a basic frame', () => {
    const desc = frameToDescription(makeFrame());
    expect(desc).toContain('58.300');
    expect(desc).toContain('depth 51 fathoms');
    expect(desc).toContain('5.5 knots');
  });

  it('should note when inside operating range', () => {
    const desc = frameToDescription(makeFrame({
      depthRelationship: {
        currentDepth: 55,
        gearDepth: 51,
        insideOperatingRange: true,
        redContourDepth: 51,
        depthOffset: 4,
        nearestShallow: 0,
      } as any,
    }));
    expect(desc).toContain('deep side');
  });

  it('should note when outside operating range', () => {
    const desc = frameToDescription(makeFrame({
      depthRelationship: {
        currentDepth: 40,
        gearDepth: 51,
        insideOperatingRange: false,
        redContourDepth: 51,
        depthOffset: -11,
        nearestShallow: 0,
      } as any,
    }));
    expect(desc).toContain('shallow side');
  });

  it('should describe fish marks', () => {
    const desc = frameToDescription(makeFrame({
      observations: [
        makeObs({ type: 'fish_mark', depth: 30 }),
        makeObs({ type: 'fish_mark', depth: 40 }),
        makeObs({ type: 'fish_mark', depth: 35 }),
      ],
    }));
    expect(desc).toContain('3 fish marks');
    expect(desc).toContain('30-40 fathoms');
  });

  it('should describe feed balls', () => {
    const desc = frameToDescription(makeFrame({
      observations: [
        makeObs({ type: 'feed_ball', depth: 28 }),
        makeObs({ type: 'feed_ball', depth: 32 }),
      ],
    }));
    expect(desc).toContain('2 feed balls');
    expect(desc).toContain('28');
    expect(desc).toContain('32');
  });

  it('should describe plankton layer', () => {
    const desc = frameToDescription(makeFrame({
      observations: [makeObs({ type: 'plankton_layer', depth: 45 })],
    }));
    expect(desc).toContain('plankton layer');
    expect(desc).toContain('45 fathoms');
  });

  it('should describe thermocline', () => {
    const desc = frameToDescription(makeFrame({
      observations: [makeObs({ type: 'thermocline', depth: 50 })],
    }));
    expect(desc).toContain('thermocline');
  });

  it('should describe bottom type', () => {
    const desc = frameToDescription(makeFrame({
      observations: [makeObs({ type: 'bottom_type', description: 'Rocky bottom' })],
    }));
    expect(desc).toContain('Rocky bottom');
  });

  it('should describe gear tracking normal', () => {
    const desc = frameToDescription(makeFrame({
      observations: [makeObs({ type: 'gear_tracking', description: 'Gear visible at 51 fathoms' })],
    }));
    expect(desc).toContain('gear tracking normally');
  });

  it('should describe abnormal gear pattern', () => {
    const desc = frameToDescription(makeFrame({
      observations: [makeObs({ type: 'gear_tracking', description: 'ABNORMAL pattern detected' })],
    }));
    expect(desc).toContain('abnormal');
  });

  it('should include sea temperature when present', () => {
    const desc = frameToDescription(makeFrame({
      seaTemp: 12.5,
    } as any));
    expect(desc).toContain('sea temp');
    expect(desc).toContain('12.5');
  });

  it('should handle empty observations gracefully', () => {
    const desc = frameToDescription(makeFrame());
    expect(desc).not.toContain('fish mark');
    expect(desc).not.toContain('feed ball');
  });
});

// ── extractFeatures ──────────────────────────────────────────

describe('extractFeatures', () => {
  it('should extract basic features', () => {
    const f = extractFeatures(makeFrame());
    expect(f.lat).toBe(58.3);
    expect(f.lon).toBe(-149.5);
    expect(f.currentDepth).toBe(51);
    expect(f.insideOperatingRange).toBe(true);
    expect(f.sog).toBe(5.5);
  });

  it('should count fish marks', () => {
    const f = extractFeatures(makeFrame({
      observations: [
        makeObs({ type: 'fish_mark', depth: 30, intensity: 0.5 }),
        makeObs({ type: 'fish_mark', depth: 40, intensity: 0.9 }),
        makeObs({ type: 'feed_ball', depth: 25 }),
      ],
    }));
    expect(f.fishMarkCount).toBe(2);
    expect(f.fishMarkDepths).toEqual([30, 40]);
    expect(f.fishMarkAvgIntensity).toBeCloseTo(0.7, 5);
    expect(f.feedBallCount).toBe(1);
  });

  it('should detect plankton presence and depth', () => {
    const f = extractFeatures(makeFrame({
      observations: [makeObs({ type: 'plankton_layer', depth: 42 })],
    }));
    expect(f.planktonPresent).toBe(true);
    expect(f.planktonDepth).toBe(42);
  });

  it('should detect thermocline presence and depth', () => {
    const f = extractFeatures(makeFrame({
      observations: [makeObs({ type: 'thermocline', depth: 48 })],
    }));
    expect(f.thermoclinePresent).toBe(true);
    expect(f.thermoclineDepth).toBe(48);
  });

  it('should classify bottom type as hard', () => {
    const f = extractFeatures(makeFrame({
      observations: [makeObs({ type: 'bottom_type', description: 'hard rocky bottom' })],
    }));
    expect(f.bottomType).toBe('hard');
  });

  it('should classify bottom type as soft', () => {
    const f = extractFeatures(makeFrame({
      observations: [makeObs({ type: 'bottom_type', description: 'soft mud bottom' })],
    }));
    expect(f.bottomType).toBe('soft');
  });

  it('should classify bottom type as weed', () => {
    const f = extractFeatures(makeFrame({
      observations: [makeObs({ type: 'bottom_type', description: 'weed growth' })],
    }));
    expect(f.bottomType).toBe('weed');
  });

  it('should return undefined bottomType for unknown description', () => {
    const f = extractFeatures(makeFrame({
      observations: [makeObs({ type: 'bottom_type', description: 'unknown terrain' })],
    }));
    expect(f.bottomType).toBeUndefined();
  });

  it('should compute biomass estimate', () => {
    const f = extractFeatures(makeFrame({
      observations: [
        makeObs({ type: 'fish_mark', depth: 30 }),
        makeObs({ type: 'fish_mark', depth: 35 }),
        makeObs({ type: 'fish_mark', depth: 40 }),
        makeObs({ type: 'feed_ball', depth: 25 }),
        makeObs({ type: 'plankton_layer', depth: 45 }),
        makeObs({ type: 'thermocline', depth: 50 }),
      ],
    }));
    // biomass = min(1.0, 3*0.08 + 1*0.15 + 0.1 + 0.05) = min(1.0, 0.54) = 0.54
    expect(f.biomassEstimate).toBe(0.54);
  });

  it('should cap biomass at 1.0', () => {
    const observations: Observation[] = [];
    for (let i = 0; i < 20; i++) {
      observations.push(makeObs({ type: 'fish_mark', depth: 30 + i }));
    }
    for (let i = 0; i < 5; i++) {
      observations.push(makeObs({ type: 'feed_ball', depth: 25 + i }));
    }
    const f = extractFeatures(makeFrame({ observations }));
    expect(f.biomassEstimate).toBe(1.0);
  });

  it('should compute activity level from observation count', () => {
    const f = extractFeatures(makeFrame({
      observations: Array(5).fill(null).map((_, i) => makeObs({ depth: 30 + i })),
    }));
    expect(f.activityLevel).toBe(0.5); // 5 * 0.1
  });

  it('should cap activity level at 1.0', () => {
    const f = extractFeatures(makeFrame({
      observations: Array(15).fill(null).map((_, i) => makeObs({ depth: 30 + i })),
    }));
    expect(f.activityLevel).toBe(1.0);
  });

  it('should compute trend indicator from nearestShallow', () => {
    const f = extractFeatures(makeFrame({
      depthRelationship: {
        currentDepth: 51,
        gearDepth: 51,
        insideOperatingRange: true,
        redContourDepth: 51,
        depthOffset: 0,
        nearestShallow: 10,
      } as any,
    }));
    expect(f.trendIndicator).toBe(0.2);
  });

  it('should compute negative trend when shallow is close', () => {
    const f = extractFeatures(makeFrame({
      depthRelationship: {
        currentDepth: 51,
        gearDepth: 51,
        insideOperatingRange: true,
        redContourDepth: 51,
        depthOffset: 0,
        nearestShallow: -10,
      } as any,
    }));
    expect(f.trendIndicator).toBe(-0.2);
  });

  it('should return zero trend when at target depth', () => {
    const f = extractFeatures(makeFrame({
      depthRelationship: {
        currentDepth: 51,
        gearDepth: 51,
        insideOperatingRange: true,
        redContourDepth: 51,
        depthOffset: 0,
        nearestShallow: 0,
      } as any,
    }));
    expect(f.trendIndicator).toBe(0);
  });

  it('should return zero avg intensity when no fish marks', () => {
    const f = extractFeatures(makeFrame());
    expect(f.fishMarkCount).toBe(0);
    expect(f.fishMarkAvgIntensity).toBe(0);
    expect(f.fishMarkDepths).toEqual([]);
  });

  it('should include sea temperature and wind when present', () => {
    const f = extractFeatures(makeFrame({
      seaTemp: 11.3,
      wind: { speedKnots: 12, directionDegrees: 270 },
    } as any));
    expect(f.seaTemp).toBe(11.3);
    expect(f.windSpeed).toBe(12);
    expect(f.windDir).toBe(270);
  });
});
