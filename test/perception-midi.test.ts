import { describe, it, expect } from "vitest";
import {
  depthToMidiNote,
  intensityToVelocity,
  observationToTimbre,
  DEFAULT_MIDI_CONFIG,
} from "../src/perception-midi";
import type { Observation } from "../src/reference-frame";

describe("depthToMidiNote", () => {
  it("returns higher notes for shallower depths", () => {
    const shallow = depthToMidiNote(5);
    const deep = depthToMidiNote(80);
    expect(shallow).toBeGreaterThan(deep);
  });

  it("returns a value between 0 and 127", () => {
    for (const d of [0, 10, 25, 50, 75, 100, 200, -10]) {
      const note = depthToMidiNote(d);
      expect(note).toBeGreaterThanOrEqual(0);
      expect(note).toBeLessThanOrEqual(127);
    }
  });

  it("clamps depths outside the configured range", () => {
    const tooShallow = depthToMidiNote(-100);
    const tooDeep = depthToMidiNote(1000);
    // Both should be within MIDI range
    expect(tooShallow).toBeGreaterThanOrEqual(0);
    expect(tooShallow).toBeLessThanOrEqual(127);
    expect(tooDeep).toBeGreaterThanOrEqual(0);
    expect(tooDeep).toBeLessThanOrEqual(127);
  });

  it("respects custom config", () => {
    const customConfig = {
      ...DEFAULT_MIDI_CONFIG,
      pitchNoteMin: 48,
      pitchNoteMax: 72,
    };
    const note = depthToMidiNote(30, customConfig);
    expect(note).toBeGreaterThanOrEqual(48);
    expect(note).toBeLessThanOrEqual(72);
  });
});

describe("intensityToVelocity", () => {
  it("converts 0.0 to minimum velocity (1)", () => {
    expect(intensityToVelocity(0)).toBe(1);
  });

  it("converts 1.0 to maximum velocity (127)", () => {
    expect(intensityToVelocity(1.0)).toBe(127);
  });

  it("converts 0.5 to ~64", () => {
    expect(intensityToVelocity(0.5)).toBe(64);
  });

  it("clamps values above 1.0 to 127", () => {
    expect(intensityToVelocity(2.0)).toBe(127);
  });

  it("clamps negative values to 1", () => {
    expect(intensityToVelocity(-0.5)).toBe(1);
  });

  it("always returns integer values", () => {
    for (const i of [0.1, 0.15, 0.23, 0.77, 0.99]) {
      const v = intensityToVelocity(i);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("observationToTimbre", () => {
  const makeObs = (overrides: Partial<Observation> = {}): Observation => ({
    type: "fish_mark",
    depth: 20,
    intensity: 0.7,
    confidence: 0.8,
    description: "test",
    frequency: "low",
    ...overrides,
  });

  it("returns 'bright' for shallow fish marks", () => {
    expect(observationToTimbre(makeObs({ type: "fish_mark", depth: 15 }))).toBe("bright");
  });

  it("returns 'warm' for deep fish marks", () => {
    expect(observationToTimbre(makeObs({ type: "fish_mark", depth: 40 }))).toBe("warm");
  });

  it("returns 'nasal' for feed balls", () => {
    expect(observationToTimbre(makeObs({ type: "feed_ball" }))).toBe("nasal");
  });

  it("returns 'breathy' for plankton layers", () => {
    expect(observationToTimbre(makeObs({ type: "plankton_layer" }))).toBe("breathy");
  });

  it("returns 'cold' for thermoclines", () => {
    expect(observationToTimbre(makeObs({ type: "thermocline" }))).toBe("cold");
  });

  it("returns 'cold' for interference", () => {
    expect(observationToTimbre(makeObs({ type: "interference" }))).toBe("cold");
  });

  it("returns 'warm' for gear tracking", () => {
    expect(observationToTimbre(makeObs({ type: "gear_tracking" }))).toBe("warm");
  });

  it("distinguishes bottom types by description", () => {
    expect(observationToTimbre(makeObs({ type: "bottom_type", description: "rocky bottom" }))).toBe("bright");
    expect(observationToTimbre(makeObs({ type: "bottom_type", description: "weed cover" }))).toBe("nasal");
    expect(observationToTimbre(makeObs({ type: "bottom_type", description: "soft mud" }))).toBe("warm");
  });
});
