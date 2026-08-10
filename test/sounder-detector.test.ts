import { describe, it, expect } from "vitest";
import { SounderDetector, DEFAULT_DETECTOR_CONFIG } from "../src/sounder-detector";
import type { SounderFrame } from "../src/reference-frame";

// Helper: create a synthetic sounder frame
function makeFrame(
  data: number[][],
  overrides: Partial<SounderFrame> = {},
): SounderFrame {
  return {
    data,
    depthRange: { min: 0, max: 100 },
    timeRange: { start: 0, end: 10 },
    frequency: "low",
    ...overrides,
  };
}

// Helper: create an empty grid
function emptyGrid(rows: number, cols: number, fill = 0): number[][] {
  return Array.from({ length: rows }, () => new Array(cols).fill(fill));
}

describe("DEFAULT_DETECTOR_CONFIG", () => {
  it("has gear depth of 51 fathoms (F/V EILEEN standard)", () => {
    expect(DEFAULT_DETECTOR_CONFIG.gearDepthFathoms).toBe(51);
  });

  it("has sensible thresholds", () => {
    expect(DEFAULT_DETECTOR_CONFIG.fishMarkMinIntensity).toBeGreaterThan(0);
    expect(DEFAULT_DETECTOR_CONFIG.fishMarkMinIntensity).toBeLessThan(1);
    expect(DEFAULT_DETECTOR_CONFIG.feedBallMinDensity).toBeGreaterThan(0.5);
  });
});

describe("SounderDetector", () => {
  describe("detectFishMarks", () => {
    it("returns empty array for empty data", () => {
      const detector = new SounderDetector();
      const result = detector.detectFishMarks(makeFrame([]));
      expect(result).toEqual([]);
    });

    it("returns empty array for uniform low-intensity data", () => {
      const detector = new SounderDetector();
      const frame = makeFrame(emptyGrid(20, 20, 0.1));
      const result = detector.detectFishMarks(frame);
      expect(result).toEqual([]);
    });

    it("detects a bright spot as a fish mark", () => {
      const detector = new SounderDetector();
      const data = emptyGrid(20, 20, 0.1);
      // Create a bright 3x3 blob
      for (let r = 8; r < 11; r++) {
        for (let c = 8; c < 11; c++) {
          data[r][c] = 0.8;
        }
      }
      const frame = makeFrame(data);
      const result = detector.detectFishMarks(frame);
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].type).toBe("fish_mark");
      expect(result[0].intensity).toBeGreaterThan(0.5);
    });

    it("assigns size categories based on blob area", () => {
      const detector = new SounderDetector();
      const data = emptyGrid(50, 50, 0.1);

      // Small fish (2 pixels)
      data[10][10] = 0.8;
      data[10][11] = 0.8;

      // Medium fish (~15 pixels)
      for (let r = 25; r < 30; r++) {
        for (let c = 25; c < 28; c++) {
          data[r][c] = 0.8;
        }
      }

      const result = detector.detectFishMarks(makeFrame(data));
      const sizes = result.map((o) => o.size);
      expect(sizes).toContain("small");
    });

    it("includes depth based on row position", () => {
      const detector = new SounderDetector();
      const data = emptyGrid(100, 20, 0.1);
      // Put a bright spot at row 50 (middle = ~50 fathoms with 0-100 range)
      data[50][10] = 0.9;
      data[50][11] = 0.9;
      data[51][10] = 0.9;
      data[51][11] = 0.9;

      const frame = makeFrame(data, { depthRange: { min: 0, max: 100 } });
      const result = detector.detectFishMarks(frame);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].depth).toBeGreaterThan(40);
      expect(result[0].depth).toBeLessThan(60);
    });
  });

  describe("detectFeedBalls", () => {
    it("returns empty array for empty data", () => {
      const detector = new SounderDetector();
      expect(detector.detectFeedBalls(makeFrame([]))).toEqual([]);
    });

    it("does not detect small bright spots as feed balls", () => {
      const detector = new SounderDetector();
      const data = emptyGrid(50, 50, 0.1);
      // Small 3x3 blob — too small for a feed ball
      for (let r = 20; r < 23; r++) {
        for (let c = 20; c < 23; c++) {
          data[r][c] = 0.9;
        }
      }
      const result = detector.detectFeedBalls(makeFrame(data));
      expect(result).toEqual([]);
    });

    it("detects large dense blobs as feed balls", () => {
      const detector = new SounderDetector();
      const data = emptyGrid(50, 50, 0.1);
      // Create a 12x12 dense blob (area = 144, above minArea of 10)
      for (let r = 15; r < 27; r++) {
        for (let c = 15; c < 27; c++) {
          data[r][c] = 0.85;
        }
      }
      const result = detector.detectFeedBalls(makeFrame(data));
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].type).toBe("feed_ball");
    });
  });

  describe("detectAll", () => {
    it("returns both observations and interference arrays", () => {
      const detector = new SounderDetector();
      const frame = makeFrame(emptyGrid(20, 20, 0.1));
      const result = detector.detectAll(frame);
      expect(result).toHaveProperty("observations");
      expect(result).toHaveProperty("interference");
      expect(Array.isArray(result.observations)).toBe(true);
      expect(Array.isArray(result.interference)).toBe(true);
    });

    it("handles completely empty frames", () => {
      const detector = new SounderDetector();
      const result = detector.detectAll(makeFrame([]));
      expect(result.observations).toEqual([]);
      expect(result.interference).toEqual([]);
    });

    it("runs all detectors without crashing on random noise", () => {
      const detector = new SounderDetector();
      const data = Array.from({ length: 50 }, () =>
        Array.from({ length: 50 }, () => Math.random()),
      );
      const result = detector.detectAll(makeFrame(data));
      // Should not crash, should return arrays
      expect(result.observations.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("with custom config", () => {
    it("accepts overridden config values", () => {
      const detector = new SounderDetector({
        fishMarkMinIntensity: 0.9,
      });
      // With very high threshold, most normal blobs should be filtered
      const data = emptyGrid(20, 20, 0.1);
      data[10][10] = 0.5;
      data[10][11] = 0.5;
      data[11][10] = 0.5;
      data[11][11] = 0.5;
      const result = detector.detectFishMarks(makeFrame(data));
      expect(result).toEqual([]);
    });
  });
});
