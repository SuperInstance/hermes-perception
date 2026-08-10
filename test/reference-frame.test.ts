import { describe, it, expect } from "vitest";
import {
  createFrame,
  framesAreCorrelatable,
  summarizeFrame,
  type ReferenceFrame,
  type Observation,
  type CatchEvent,
  type InterferenceAlert,
} from "../src/reference-frame";

describe("createFrame", () => {
  it("creates a frame with all required fields", () => {
    const frame = createFrame({ lat: 57.79, lon: -152.40, sog: 1.5, cog: 180, depth: 55 });
    expect(frame.timestamp).toBeDefined();
    expect(frame.frameId).toContain("frame-");
    expect(frame.position).toEqual({ lat: 57.79, lon: -152.40 });
    expect(frame.speedAndHeading).toEqual({ sog: 1.5, cog: 180 });
    expect(frame.depthRelationship.currentDepth).toBe(55);
    expect(frame.depthRelationship.gearDepth).toBe(51);
  });

  it("marks insideOperatingRange=true when depth >= 51", () => {
    const frame = createFrame({ lat: 57.79, lon: -152.40, sog: 1.5, cog: 180, depth: 51 });
    expect(frame.depthRelationship.insideOperatingRange).toBe(true);
  });

  it("marks insideOperatingRange=false when depth < 51", () => {
    const frame = createFrame({ lat: 57.79, lon: -152.40, sog: 1.5, cog: 180, depth: 45 });
    expect(frame.depthRelationship.insideOperatingRange).toBe(false);
  });

  it("computes nearestShallow correctly when deeper than gear depth", () => {
    const frame = createFrame({ lat: 57.79, lon: -152.40, sog: 1.5, cog: 180, depth: 55 });
    expect(frame.depthRelationship.nearestShallow).toBe(4); // 55 - 51 = 4
  });

  it("computes nearestShallow correctly when shallower than gear depth", () => {
    const frame = createFrame({ lat: 57.79, lon: -152.40, sog: 1.5, cog: 180, depth: 45 });
    expect(frame.depthRelationship.nearestShallow).toBe(-6); // 45 - 51 = -6
  });

  it("generates unique frame IDs", () => {
    const f1 = createFrame({ lat: 0, lon: 0, sog: 0, cog: 0, depth: 51 });
    const f2 = createFrame({ lat: 0, lon: 0, sog: 0, cog: 0, depth: 51 });
    expect(f1.frameId).not.toBe(f2.frameId);
  });

  it("starts with empty observations", () => {
    const frame = createFrame({ lat: 0, lon: 0, sog: 0, cog: 0, depth: 51 });
    expect(frame.observations).toEqual([]);
  });

  it("defaults source to pulse", () => {
    const frame = createFrame({ lat: 0, lon: 0, sog: 0, cog: 0, depth: 51 });
    expect(frame.source).toBe("pulse");
  });
});

describe("framesAreCorrelatable", () => {
  const baseFrame: ReferenceFrame = {
    timestamp: "2026-08-10T04:00:00Z",
    frameId: "test-1",
    position: { lat: 57.79, lon: -152.40 },
    speedAndHeading: { sog: 1.5, cog: 180 },
    depthRelationship: {
      currentDepth: 55,
      gearDepth: 51,
      insideOperatingRange: true,
      nearestShallow: 4,
    },
    observations: [],
    source: "pulse",
  };

  it("returns true for identical positions and close timestamps", () => {
    const a = { ...baseFrame };
    const b = { ...baseFrame, timestamp: "2026-08-10T04:01:00Z" };
    expect(framesAreCorrelatable(a, b)).toBe(true);
  });

  it("returns false when time difference exceeds maxTimeDiffSeconds", () => {
    const a = { ...baseFrame };
    const b = { ...baseFrame, timestamp: "2026-08-10T04:10:00Z" }; // 10 min later
    expect(framesAreCorrelatable(a, b, 300, 500)).toBe(false);
  });

  it("returns false when distance exceeds maxDistanceM", () => {
    const a = { ...baseFrame };
    const b = { ...baseFrame, position: { lat: 57.80, lon: -152.40 } };
    // ~1.1 km apart — exceeds 500m default
    expect(framesAreCorrelatable(a, b)).toBe(false);
  });

  it("returns true for very close positions", () => {
    const a = { ...baseFrame };
    const b = { ...baseFrame, position: { lat: 57.7901, lon: -152.4001 } };
    expect(framesAreCorrelatable(a, b)).toBe(true);
  });

  it("respects custom maxDistanceM parameter", () => {
    const a = { ...baseFrame };
    const b = { ...baseFrame, position: { lat: 57.794, lon: -152.40 } };
    // ~444m apart — within 500m but outside 100m
    expect(framesAreCorrelatable(a, b, 300, 100)).toBe(false);
    expect(framesAreCorrelatable(a, b, 300, 500)).toBe(true);
  });

  it("handles frames at the exact same position", () => {
    const a = { ...baseFrame };
    expect(framesAreCorrelatable(a, a)).toBe(true);
  });
});

describe("summarizeFrame", () => {
  const makeFrame = (overrides: Partial<ReferenceFrame> = {}): ReferenceFrame => ({
    timestamp: "2026-08-10T04:00:00Z",
    frameId: "test-1",
    position: { lat: 57.79, lon: -152.40 },
    speedAndHeading: { sog: 1.5, cog: 180 },
    depthRelationship: {
      currentDepth: 55,
      gearDepth: 51,
      insideOperatingRange: true,
      nearestShallow: 4,
    },
    observations: [],
    source: "pulse",
    ...overrides,
  });

  it("includes timestamp and position in summary", () => {
    const summary = summarizeFrame(makeFrame());
    expect(summary).toContain("2026-08-10T04:00:00Z");
    expect(summary).toContain("57.7900");
    expect(summary).toContain("-152.4000");
  });

  it("shows DEEP when inside operating range", () => {
    const summary = summarizeFrame(makeFrame());
    expect(summary).toContain("DEEP");
  });

  it("shows SHALLOW when outside operating range", () => {
    const summary = summarizeFrame(
      makeFrame({
        depthRelationship: {
          currentDepth: 45,
          gearDepth: 51,
          insideOperatingRange: false,
          nearestShallow: -6,
        },
      }),
    );
    expect(summary).toContain("SHALLOW");
  });

  it("counts fish marks and feed balls in observations", () => {
    const observations: Observation[] = [
      { type: "fish_mark", depth: 10, intensity: 0.8, confidence: 0.9, description: "test", frequency: "low" },
      { type: "fish_mark", depth: 12, intensity: 0.7, confidence: 0.8, description: "test2", frequency: "low" },
      { type: "feed_ball", depth: 15, intensity: 0.9, confidence: 0.95, description: "bait", frequency: "low" },
    ];
    const summary = summarizeFrame(makeFrame({ observations }));
    expect(summary).toContain("2 marks");
    expect(summary).toContain("1 feed balls");
  });

  it("includes CATCH when catch events present", () => {
    const catchEvents: CatchEvent[] = [
      {
        species: "chum",
        time: "2026-08-10T04:01:00Z",
        location: { lat: 57.79, lon: -152.40 },
        gearNumber: 1,
        confidence: 1.0,
        detectionMethod: "visual",
      },
    ];
    const summary = summarizeFrame(makeFrame({ catchEvents }));
    expect(summary).toContain("CATCH");
  });

  it("includes INTERFERENCE when interference patterns present", () => {
    const interferencePatterns: InterferenceAlert[] = [
      {
        type: "vertical_lines",
        severity: 0.6,
        recommendation: "check_radar",
        timestamp: "2026-08-10T04:00:00Z",
        frequency: "low",
      },
    ];
    const summary = summarizeFrame(makeFrame({ interferencePatterns }));
    expect(summary).toContain("INTERFERENCE");
  });

  it("handles empty frame with no observations or events", () => {
    const summary = summarizeFrame(makeFrame());
    expect(summary).toContain("0 marks");
    expect(summary).toContain("0 feed balls");
    expect(summary).not.toContain("CATCH");
    expect(summary).not.toContain("INTERFERENCE");
  });
});
