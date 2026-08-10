/**
 * Sounder Detector — reads echogram data and finds patterns.
 *
 * The sounder IS a perception stream. The TZ Pro displays an echogram
 * which is a 2D visualization of what's under the boat over time.
 * This module converts that visualization back into semantic observations.
 *
 * Adapts the pattern detection philosophy from:
 *   - slackwater-perception: finding meaningful patterns in perceptual streams
 *   - sensor-bridge's PatternDetector: rolling windows, threshold checks
 *
 * The TZ Pro echogram:
 *   - X axis = time (most recent on the right, history scrolling left)
 *   - Y axis = depth (surface at top, bottom at bottom)
 *   - Color/brightness = signal intensity (returns from fish, bottom, etc.)
 *   - Low frequency (50 kHz): sees biomass, larger area, less detail
 *   - High frequency (200 kHz): sees individual targets, more detail
 *
 * Detection methods:
 *   1. Fish marks — individual fish (arcs, dots, streaks)
 *   2. Feed balls — dense bait concentrations
 *   3. Plankton layers — diffuse scattering layers
 *   4. Bottom type — hard/soft/weed characterization
 *   5. Thermocline — faint horizontal temperature boundary
 *   6. Interference — vertical lines from nearby boats
 *   7. Gear tracking — trolling gear (cannonballs) on the sounder
 */

import {
  SounderFrame,
  Observation,
  InterferenceAlert,
} from './reference-frame';

// ──────────────────────────────────────────────────────────────
// Detection Configuration
// ──────────────────────────────────────────────────────────────

export interface DetectorConfig {
  // Fish mark detection
  fishMarkMinIntensity: number;     // Minimum intensity to be a mark
  fishMarkMinContrast: number;      // Minimum contrast vs surroundings
  fishMarkMaxSize: number;          // Maximum area in pixels (above = school)

  // Feed ball detection
  feedBallMinDensity: number;       // Minimum density for a bait ball
  feedBallMinArea: number;          // Minimum area
  feedBallMaxArea: number;          // Maximum area before it's a school

  // Plankton layer detection
  planktonMinWidth: number;         // Minimum horizontal extent (columns)
  planktonMaxIntensity: number;     // Plankton is diffuse, not bright

  // Bottom detection
  bottomIntensityThreshold: number; // Minimum intensity for "bottom"
  bottomSearchStartRow: number;     // Start searching from this row fraction (0-1)

  // Thermocline detection
  thermoclineMinWidth: number;      // Minimum horizontal extent
  thermoclineMaxIntensity: number;  // Thermocline is faint
  thermoclineUniformity: number;    // How uniform the line must be

  // Interference detection
  interferenceMinHeight: number;    // Vertical line minimum height (row fraction)
  interferenceMinPersistence: number; // How many consecutive columns

  // Gear tracking
  gearDepthFathoms: number;         // Expected gear depth (51 for F/V EILEEN)
  gearSearchTolerance: number;      // Search ± this many fathoms around gear depth
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  fishMarkMinIntensity: 0.35,
  fishMarkMinContrast: 0.15,
  fishMarkMaxSize: 50,
  feedBallMinDensity: 0.6,
  feedBallMinArea: 10,
  feedBallMaxArea: 200,
  planktonMinWidth: 20,
  planktonMaxIntensity: 0.3,
  bottomIntensityThreshold: 0.7,
  bottomSearchStartRow: 0.6,
  thermoclineMinWidth: 30,
  thermoclineMaxIntensity: 0.25,
  thermoclineUniformity: 0.7,
  interferenceMinHeight: 0.5,
  interferenceMinPersistence: 5,
  gearDepthFathoms: 51,
  gearSearchTolerance: 3,
};

// ──────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────

/**
 * Convert a row index to a depth in fathoms.
 */
function rowToDepth(row: number, totalRows: number, frame: SounderFrame): number {
  const fraction = row / totalRows;
  return frame.depthRange.min + fraction * (frame.depthRange.max - frame.depthRange.min);
}

/**
 * Convert a depth in fathoms to a row index.
 */
function depthToRow(depth: number, totalRows: number, frame: SounderFrame): number {
  const fraction = (depth - frame.depthRange.min) / (frame.depthRange.max - frame.depthRange.min);
  return Math.round(fraction * totalRows);
}

/**
 * Calculate the local average intensity around a pixel.
 */
function localAverage(data: number[][], row: number, col: number, radius: number): number {
  let sum = 0;
  let count = 0;
  const rows = data.length;
  const cols = data[0]?.length ?? 0;

  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < rows && c >= 0 && c < cols) {
        sum += data[r][c];
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Find connected components (blob detection) above a threshold.
 * Returns a list of blobs, each defined by their pixel coordinates.
 */
function findBlobs(
  data: number[][],
  threshold: number,
  minArea: number = 1,
  maxArea: number = Infinity,
): { pixels: [number, number][]; centroid: [number, number]; area: number; avgIntensity: number }[] {
  const rows = data.length;
  const cols = data[0]?.length ?? 0;
  const visited: boolean[][] = Array.from({ length: rows }, () =>
    new Array(cols).fill(false),
  );

  const blobs: { pixels: [number, number][]; centroid: [number, number]; area: number; avgIntensity: number }[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (visited[r][c] || data[r][c] < threshold) {
        visited[r][c] = true;
        continue;
      }

      // BFS flood fill
      const queue: [number, number][] = [[r, c]];
      const pixels: [number, number][] = [];
      let intensitySum = 0;

      while (queue.length > 0) {
        const [cr, cc] = queue.shift()!;
        if (cr < 0 || cr >= rows || cc < 0 || cc >= cols) continue;
        if (visited[cr][cc] || data[cr][cc] < threshold) continue;

        visited[cr][cc] = true;
        pixels.push([cr, cc]);
        intensitySum += data[cr][cc];

        queue.push([cr - 1, cc], [cr + 1, cc], [cr, cc - 1], [cr, cc + 1]);
      }

      if (pixels.length >= minArea && pixels.length <= maxArea) {
        const sumRow = pixels.reduce((s, [pr]) => s + pr, 0);
        const sumCol = pixels.reduce((s, [, pc]) => s + pc, 0);
        blobs.push({
          pixels,
          centroid: [sumRow / pixels.length, sumCol / pixels.length],
          area: pixels.length,
          avgIntensity: intensitySum / pixels.length,
        });
      }
    }
  }

  return blobs;
}

/**
 * Calculate density of high-intensity pixels in a region.
 */
function regionDensity(data: number[][], threshold: number, pixels: [number, number][]): number {
  if (pixels.length === 0) return 0;
  let above = 0;
  for (const [r, c] of pixels) {
    if (data[r]?.[c] !== undefined && data[r][c] >= threshold) {
      above++;
    }
  }
  return above / pixels.length;
}

// ──────────────────────────────────────────────────────────────
// SounderDetector
// ──────────────────────────────────────────────────────────────

/**
 * The main sounder pattern detector.
 *
 * Takes SounderFrame data (2D intensity arrays from the TZ Pro display)
 * and produces Observation objects representing what Hermes "sees."
 *
 * Usage:
 *   const detector = new SounderDetector();
 *   const result = detector.detectAll(sounderFrame);
 *   console.log(result.observations);
 *
 * Each detection method can also be called individually:
 *   detector.detectFishMarks(frame);
 *   detector.detectFeedBalls(frame);
 *   etc.
 */
export class SounderDetector {
  private config: DetectorConfig;

  constructor(config?: Partial<DetectorConfig>) {
    this.config = { ...DEFAULT_DETECTOR_CONFIG, ...config };
  }

  /**
   * Run all detection methods on a frame.
   */
  detectAll(frame: SounderFrame): {
    observations: Observation[];
    interference: InterferenceAlert[];
  } {
    const observations: Observation[] = [];
    const interference: InterferenceAlert[] = [];

    // Run all detectors
    observations.push(...this.detectFishMarks(frame));
    observations.push(...this.detectFeedBalls(frame));
    observations.push(...this.detectPlanktonLayers(frame));

    const bottom = this.detectBottomType(frame);
    if (bottom) observations.push(bottom);

    const thermo = this.detectThermocline(frame);
    if (thermo) observations.push(thermo);

    const gear = this.detectGearTracking(frame);
    if (gear) observations.push(gear);

    const interf = this.detectInterference(frame);
    if (interf) interference.push(interf);

    return { observations, interference };
  }

  /**
   * 1. Detect individual fish marks.
   *
   * On high frequency: fish appear as distinct arcs, dots, or streaks.
   *   - Arcs: fish swimming through the beam — characteristic crescent shape
   *   - Dots: fish directly under the boat for a short time
   *   - Streaks: fish moving across the beam horizontally
   *
   * On low frequency: individual fish are harder to see, but larger
   * predators (kings) may still show as distinct marks.
   *
   * Detection approach:
   *   - Find blobs above a threshold intensity
   *   - Filter by size (small blobs = individual fish)
   *   - Calculate contrast against surrounding area
   *   - Larger blobs with high density → feed balls (detected separately)
   */
  detectFishMarks(frame: SounderFrame): Observation[] {
    const observations: Observation[] = [];
    const { data } = frame;

    if (!data || data.length === 0) return observations;

    const blobs = findBlobs(
      data,
      this.config.fishMarkMinIntensity,
      2, // min area: at least 2 pixels
      this.config.fishMarkMaxSize,
    );

    for (const blob of blobs) {
      // Contrast check
      const surroundingIntensity = localAverage(
        data,
        Math.round(blob.centroid[0]),
        Math.round(blob.centroid[1]),
        5,
      );
      const contrast = blob.avgIntensity - surroundingIntensity;

      if (contrast < this.config.fishMarkMinContrast) continue;

      const depth = rowToDepth(blob.centroid[0], data.length, frame);

      // Estimate size
      let size: 'small' | 'medium' | 'large';
      if (blob.area < 8) size = 'small';
      else if (blob.area < 25) size = 'medium';
      else size = 'large';

      // Confidence based on contrast and intensity
      const confidence = Math.min(
        1.0,
        (contrast / this.config.fishMarkMinContrast) * 0.5 +
          (blob.avgIntensity / this.config.fishMarkMinIntensity) * 0.5,
      );

      observations.push({
        type: 'fish_mark',
        depth: Math.round(depth * 10) / 10,
        intensity: Math.round(blob.avgIntensity * 100) / 100,
        size,
        confidence: Math.round(confidence * 100) / 100,
        description: this.describeFishMark(depth, size, frame.frequency),
        frequency: frame.frequency,
        echogramLocation: {
          rowStart: Math.min(...blob.pixels.map((p) => p[0])),
          rowEnd: Math.max(...blob.pixels.map((p) => p[0])),
          colStart: Math.min(...blob.pixels.map((p) => p[1])),
          colEnd: Math.max(...blob.pixels.map((p) => p[1])),
        },
      });
    }

    return observations;
  }

  /**
   * 2. Detect feed balls (bait fish concentrations).
   *
   * Bait balls appear as dense, roughly round concentrations of high
   * intensity. They're usually at a specific depth layer where
   * plankton concentrates. They look different from individual fish:
   *   - Much larger area
   *   - High internal density
   *   - Often round/elliptical
   *   - Sustained over multiple pings
   *
   * Feed balls are where the food chain converges. Where there are
   * feed balls, salmon are usually nearby.
   */
  detectFeedBalls(frame: SounderFrame): Observation[] {
    const observations: Observation[] = [];
    const { data } = frame;

    if (!data || data.length === 0) return observations;

    // Find larger blobs with high density
    const blobs = findBlobs(
      data,
      this.config.fishMarkMinIntensity + 0.1, // higher threshold for feed
      this.config.feedBallMinArea,
      this.config.feedBallMaxArea,
    );

    for (const blob of blobs) {
      const density = regionDensity(data, this.config.fishMarkMinIntensity, blob.pixels);

      if (density < this.config.feedBallMinDensity) continue;

      const depth = rowToDepth(blob.centroid[0], data.length, frame);

      const confidence = Math.min(1.0, density * (blob.area / this.config.feedBallMaxArea));

      observations.push({
        type: 'feed_ball',
        depth: Math.round(depth * 10) / 10,
        intensity: Math.round(blob.avgIntensity * 100) / 100,
        size: blob.area > this.config.feedBallMaxArea / 2 ? 'large' : 'medium',
        confidence: Math.round(confidence * 100) / 100,
        description: `Bait ball at ${depth.toFixed(0)} fathoms, density ${(density * 100).toFixed(0)}%`,
        frequency: frame.frequency,
        depthRange: {
          min: rowToDepth(Math.min(...blob.pixels.map((p) => p[0])), data.length, frame),
          max: rowToDepth(Math.max(...blob.pixels.map((p) => p[0])), data.length, frame),
        },
      });
    }

    return observations;
  }

  /**
   * 3. Detect plankton layers (Deep Scattering Layer).
   *
   * Plankton appear as diffuse, horizontal bands at specific depths.
   * They're not bright like fish marks — they're a subtle, widespread
   * increase in intensity at a particular depth band.
   *
   * The Deep Scattering Layer (DSL) is the ocean's background hum.
   * It rises at night and sinks at dawn. Feed balls often form at
   * the DSL boundary because that's where the food is.
   *
   * Detection approach:
   *   - For each row, calculate the average intensity across all columns
   *   - Find rows where the average is elevated but below fish-mark threshold
   *   - Check for horizontal continuity (the layer should persist across columns)
   */
  detectPlanktonLayers(frame: SounderFrame): Observation[] {
    const observations: Observation[] = [];
    const { data } = frame;

    if (!data || data.length === 0) return observations;

    const rows = data.length;
    const cols = data[0].length;

    // Calculate average intensity per row
    const rowAverages: number[] = [];
    for (let r = 0; r < rows; r++) {
      let sum = 0;
      for (let c = 0; c < cols; c++) {
        sum += data[r][c];
      }
      rowAverages.push(sum / cols);
    }

    // Find rows with elevated but diffuse intensity
    const planktonRows: number[] = [];
    for (let r = 0; r < rows; r++) {
      if (
        rowAverages[r] > 0.05 && // above background
        rowAverages[r] < this.config.planktonMaxIntensity && // diffuse, not bright
        rowAverages[r] > rowAverages[Math.max(0, r - 3)] * 1.3 // elevated vs surroundings
      ) {
        planktonRows.push(r);
      }
    }

    // Group consecutive rows into layers
    if (planktonRows.length < 2) return observations;

    const layers: { startRow: number; endRow: number; avgIntensity: number }[] = [];
    let groupStart = planktonRows[0];

    for (let i = 1; i <= planktonRows.length; i++) {
      if (i === planktonRows.length || planktonRows[i] - planktonRows[i - 1] > 3) {
        const groupEnd = planktonRows[i - 1];
        const groupAvg =
          rowAverages
            .slice(groupStart, groupEnd + 1)
            .reduce((s, v) => s + v, 0) / (groupEnd - groupStart + 1);

        layers.push({
          startRow: groupStart,
          endRow: groupEnd,
          avgIntensity: groupAvg,
        });

        if (i < planktonRows.length) groupStart = planktonRows[i];
      }
    }

    for (const layer of layers) {
      const depthMin = rowToDepth(layer.startRow, rows, frame);
      const depthMax = rowToDepth(layer.endRow, rows, frame);
      const depthMid = (depthMin + depthMax) / 2;

      // Check horizontal continuity
      let continuousCount = 0;
      for (let c = 0; c < cols; c++) {
        let rowSum = 0;
        for (let r = layer.startRow; r <= layer.endRow; r++) {
          rowSum += data[r][c];
        }
        if (rowSum / (layer.endRow - layer.startRow + 1) > layer.avgIntensity * 0.7) {
          continuousCount++;
        }
      }
      const continuity = continuousCount / cols;

      if (continuity < 0.5) continue; // Not continuous enough

      observations.push({
        type: 'plankton_layer',
        depth: Math.round(depthMid * 10) / 10,
        intensity: Math.round(layer.avgIntensity * 100) / 100,
        size: layer.endRow - layer.startRow > 5 ? 'large' : 'medium',
        confidence: Math.round(continuity * 100) / 100,
        description: `Plankton layer at ${depthMin.toFixed(0)}-${depthMax.toFixed(0)} fathoms, ${(continuity * 100).toFixed(0)}% continuous`,
        frequency: frame.frequency,
        depthRange: {
          min: Math.round(depthMin * 10) / 10,
          max: Math.round(depthMax * 10) / 10,
        },
      });
    }

    return observations;
  }

  /**
   * 4. Detect bottom type.
   *
   * Bottom returns have characteristic shapes on the echogram:
   *   - Hard bottom (rock/reef): sharp, bright return with a distinct
   *     "double echo" below the actual bottom line
   *   - Soft bottom (mud/sand): diffuse, weaker return, no double echo
   *   - Weeds: fuzzy, rising returns above the actual bottom
   *
   * The bottom is the strongest continuous return at the deepest part
   * of the echogram. We find it and characterize it.
   */
  detectBottomType(frame: SounderFrame): Observation | null {
    const { data } = frame;

    if (!data || data.length === 0) return null;

    const rows = data.length;
    const cols = data[0].length;
    const searchStart = Math.floor(rows * this.config.bottomSearchStartRow);

    // Find the bottom: for each column, find the deepest high-intensity row
    const bottomDepths: number[] = [];
    let maxIntensityAtBottom = 0;
    let bottomRowSum = 0;
    let bottomRowCount = 0;

    for (let c = 0; c < cols; c++) {
      for (let r = rows - 1; r >= searchStart; r--) {
        if (data[r][c] >= this.config.bottomIntensityThreshold) {
          bottomDepths.push(r);
          maxIntensityAtBottom = Math.max(maxIntensityAtBottom, data[r][c]);
          bottomRowSum += r;
          bottomRowCount++;
          break;
        }
      }
    }

    if (bottomDepths.length === 0) return null;

    // Average bottom depth
    const avgBottomRow = bottomRowSum / bottomRowCount;
    const bottomDepth = rowToDepth(avgBottomRow, rows, frame);

    // Check for double echo (hard bottom indicator)
    let doubleEchoCount = 0;
    const echoOffset = Math.floor(rows * 0.05); // ~5% deeper
    for (const br of bottomDepths) {
      const echoRow = br + echoOffset;
      if (echoRow < rows && data[echoRow]?.some((v) => v > 0.4)) {
        doubleEchoCount++;
      }
    }

    // Check for "fuzzy" bottom (weeds)
    // Weeds cause the bottom return to be less sharp — more spread vertically
    const bottomSpread = bottomDepths.length > 1
      ? Math.stddev(bottomDepths)
      : 0;

    // Classify
    let bottomType: 'hard' | 'soft' | 'weed' | 'unknown';
    let description: string;
    let confidence: number;

    if (doubleEchoCount / bottomDepths.length > 0.5) {
      bottomType = 'hard';
      description = `Hard bottom (rock/reef) at ${bottomDepth.toFixed(0)} fathoms — double echo detected`;
      confidence = 0.7 + (doubleEchoCount / bottomDepths.length) * 0.3;
    } else if (bottomSpread > 3) {
      bottomType = 'weed';
      description = `Weedy bottom at ${bottomDepth.toFixed(0)} fathoms — fuzzy return`;
      confidence = 0.6;
    } else if (maxIntensityAtBottom < 0.85) {
      bottomType = 'soft';
      description = `Soft bottom (mud/sand) at ${bottomDepth.toFixed(0)} fathoms`;
      confidence = 0.6;
    } else {
      bottomType = 'unknown';
      description = `Bottom at ${bottomDepth.toFixed(0)} fathoms, unclassified`;
      confidence = 0.4;
    }

    return {
      type: 'bottom_type',
      depth: Math.round(bottomDepth * 10) / 10,
      intensity: Math.round(maxIntensityAtBottom * 100) / 100,
      size: 'large',
      confidence: Math.round(confidence * 100) / 100,
      description,
      frequency: 'both', // bottom shows on both frequencies
    };
  }

  /**
   * 5. Detect thermocline.
   *
   * A thermocline appears as a faint, continuous horizontal line
   * across the echogram. It's where water temperature changes rapidly
   * with depth. The density change causes a weak acoustic reflection.
   *
   * Fish often concentrate at or near the thermocline because that's
   * where temperature-driven nutrient upwelling occurs.
   *
   * Detection approach:
   *   - Scan for a thin, horizontal band of slightly elevated intensity
   *   - Must be continuous across most of the echogram width
   *   - Must be much fainter than plankton layers
   *   - Must be thinner (1-3 rows typically)
   */
  detectThermocline(frame: SounderFrame): Observation | null {
    const { data } = frame;

    if (!data || data.length === 0) return null;

    const rows = data.length;
    const cols = data[0].length;

    // Calculate row averages for thin horizontal bands
    const rowAverages: number[] = [];
    for (let r = 0; r < rows; r++) {
      let sum = 0;
      for (let c = 0; c < cols; c++) {
        sum += data[r][c];
      }
      rowAverages.push(sum / cols);
    }

    // Look for a thin line: one row where average is slightly elevated
    // compared to rows above and below
    let bestRow = -1;
    let bestScore = 0;

    for (let r = 5; r < rows - 5; r++) {
      const localAvg = rowAverages[r];
      const aboveAvg = (rowAverages[r - 3] + rowAverages[r - 2] + rowAverages[r - 1]) / 3;
      const belowAvg = (rowAverages[r + 1] + rowAverages[r + 2] + rowAverages[r + 3]) / 3;
      const background = (aboveAvg + belowAvg) / 2;

      // Thermocline conditions:
      //   - Slightly elevated (not as bright as fish marks)
      //   - Thin (one or two rows)
      //   - Above background but below plankton threshold
      if (
        localAvg > background * 1.3 &&
        localAvg < this.config.thermoclineMaxIntensity &&
        localAvg > 0.03
      ) {
        // Check continuity
        let continuousCount = 0;
        for (let c = 0; c < cols; c++) {
          if (data[r][c] > background * 1.1) continuousCount++;
        }
        const continuity = continuousCount / cols;

        if (continuity >= this.config.thermoclineUniformity) {
          const score = continuity * (localAvg - background);
          if (score > bestScore) {
            bestScore = score;
            bestRow = r;
          }
        }
      }
    }

    if (bestRow === -1) return null;

    const depth = rowToDepth(bestRow, rows, frame);

    return {
      type: 'thermocline',
      depth: Math.round(depth * 10) / 10,
      intensity: Math.round(rowAverages[bestRow] * 100) / 100,
      size: 'large', // thermoclines are spatially extensive
      confidence: Math.round(Math.min(1.0, bestScore * 10) * 100) / 100,
      description: `Thermocline detected at ${depth.toFixed(0)} fathoms — fish may concentrate here`,
      frequency: frame.frequency,
    };
  }

  /**
   * 6. Detect interference (vertical lines from nearby boats).
   *
   * Vertical lines on the echogram are caused by other boats' sonar
   * operating at similar frequencies. The interference appears as
   * vertical streaks that persist across multiple pings.
   *
   * This is operationally important:
   *   - Another boat is fishing nearby (check radar)
   *   - Their sonar might be scaring fish
   *   - It could be a fleet mate or a competitor
   *
   * Detection approach:
   *   - For each column, count how many consecutive rows have elevated intensity
   *   - A vertical line spanning >50% of the water column = interference
   *   - Multiple adjacent columns with the same pattern = strong interference
   */
  detectInterference(frame: SounderFrame): InterferenceAlert | null {
    const { data } = frame;

    if (!data || data.length === 0) return null;

    const rows = data.length;
    const cols = data[0].length;
    const minHeight = Math.floor(rows * this.config.interferenceMinHeight);

    // For each column, find the longest vertical streak of elevated intensity
    const columnStreaks: { col: number; streakLength: number; avgIntensity: number }[] = [];

    for (let c = 0; c < cols; c++) {
      let bestStreak = 0;
      let currentStreak = 0;
      let streakIntensitySum = 0;
      let bestIntensitySum = 0;

      for (let r = 0; r < rows; r++) {
        // "Elevated" means above local background
        const background = localAverage(data, r, c, 7);
        if (data[r][c] > background + 0.1 && data[r][c] > 0.2) {
          currentStreak++;
          streakIntensitySum += data[r][c];
        } else {
          if (currentStreak > bestStreak) {
            bestStreak = currentStreak;
            bestIntensitySum = streakIntensitySum;
          }
          currentStreak = 0;
          streakIntensitySum = 0;
        }
      }
      if (currentStreak > bestStreak) {
        bestStreak = currentStreak;
        bestIntensitySum = streakIntensitySum;
      }

      if (bestStreak >= minHeight) {
        columnStreaks.push({
          col: c,
          streakLength: bestStreak,
          avgIntensity: bestIntensitySum / bestStreak,
        });
      }
    }

    if (columnStreaks.length < this.config.interferenceMinPersistence) return null;

    // Check if the streaks are in adjacent columns (real interference pattern)
    columnStreaks.sort((a, b) => a.col - b.col);
    let maxAdjacent = 1;
    let currentAdjacent = 1;

    for (let i = 1; i < columnStreaks.length; i++) {
      if (columnStreaks[i].col - columnStreaks[i - 1].col <= 2) {
        currentAdjacent++;
        maxAdjacent = Math.max(maxAdjacent, currentAdjacent);
      } else {
        currentAdjacent = 1;
      }
    }

    if (maxAdjacent < this.config.interferenceMinPersistence) return null;

    // Calculate severity
    const avgIntensity =
      columnStreaks.reduce((s, cs) => s + cs.avgIntensity, 0) / columnStreaks.length;
    const severity = Math.min(
      1.0,
      (maxAdjacent / cols) * 0.5 + avgIntensity * 0.5,
    );

    const recommendation: InterferenceAlert['recommendation'] =
      severity > 0.6 ? 'check_radar' : severity > 0.3 ? 'check_outward_camera' : 'note_only';

    return {
      type: 'vertical_lines',
      severity: Math.round(severity * 100) / 100,
      recommendation,
      timestamp: new Date().toISOString(),
      frequency: frame.frequency,
    };
  }

  /**
   * 7. Detect trolling gear on the sounder.
   *
   * The F/V EILEEN trolls with cannonballs at 51 fathoms. These
   * appear on the sounder as distinct marks at the gear depth.
   * If the gear mark moves or changes shape abnormally, it could
   * indicate:
   *   - A fish on (cannonball bouncing, mark stretching)
   *   - A tangle (mark displaced, unusual shape)
   *   - Gear crossing (two marks merging)
   *
   * Detection approach:
   *   - Search in a narrow depth band around the expected gear depth
   *   - Look for consistent marks that appear across most pings
   *   - Compare mark shape over time to detect abnormalities
   */
  detectGearTracking(frame: SounderFrame): Observation | null {
    const { data } = frame;

    if (!data || data.length === 0) return null;

    const rows = data.length;
    const cols = data[0].length;

    // Search in a band around the expected gear depth
    const gearRow = depthToRow(this.config.gearDepthFathoms, rows, frame);
    const tolerance = Math.ceil(
      (this.config.gearSearchTolerance / (frame.depthRange.max - frame.depthRange.min)) * rows,
    );

    const searchStart = Math.max(0, gearRow - tolerance);
    const searchEnd = Math.min(rows - 1, gearRow + tolerance);

    // Check for consistent marks in the gear depth band
    let pingsWithMarks = 0;
    let totalIntensity = 0;

    for (let c = 0; c < cols; c++) {
      let foundMark = false;
      for (let r = searchStart; r <= searchEnd; r++) {
        if (data[r][c] >= 0.4) {
          foundMark = true;
          totalIntensity += data[r][c];
        }
      }
      if (foundMark) pingsWithMarks++;
    }

    const pingRatio = pingsWithMarks / cols;
    const avgIntensity = pingsWithMarks > 0 ? totalIntensity / pingsWithMarks : 0;

    // Gear should be visible in most pings (it's being towed, so it's always there)
    if (pingRatio < 0.5) return null;

    // Check for abnormal gear behavior (fish on?)
    // If the gear mark area is larger than usual or has very high intensity
    // in some pings, it might indicate a fish on the gear
    let abnormalCount = 0;
    for (let c = 0; c < cols; c++) {
      let highIntensityPixels = 0;
      for (let r = searchStart; r <= searchEnd; r++) {
        if (data[r][c] >= 0.7) highIntensityPixels++;
      }
      if (highIntensityPixels > tolerance * 2 + 2) {
        abnormalCount++;
      }
    }

    const abnormalRatio = abnormalCount / cols;
    const hasAbnormality = abnormalRatio > 0.15;

    const description = hasAbnormality
      ? `Gear at ${this.config.gearDepthFathoms} fm — ABNORMAL pattern detected (possible fish on)`
      : `Gear tracking normally at ${this.config.gearDepthFathoms} fathoms`;

    return {
      type: 'gear_tracking',
      depth: this.config.gearDepthFathoms,
      intensity: Math.round(avgIntensity * 100) / 100,
      size: hasAbnormality ? 'large' : 'medium',
      confidence: Math.round(pingRatio * 100) / 100,
      description,
      frequency: frame.frequency,
    };
  }

  // ── Private helpers ──────────────────────────────────────────

  private describeFishMark(depth: number, size: string, freq: string): string {
    const depthStr = depth.toFixed(0);
    const freqNote = freq === 'high' ? 'distinct target' : 'biomass mark';
    const sizeNote = size === 'small' ? 'likely juvenile or small species'
      : size === 'medium' ? 'likely salmon-sized'
      : 'large mark — possible predator or school';
    return `${freqNote} at ${depthStr} fathoms, ${sizeNote}`;
  }
}

// Add Math.stddev polyfill (not standard in JS/TS)
declare global {
  interface Math {
    stddev(arr: number[]): number;
  }
}

// Implement Math.stddev if not present
if (typeof (Math as any).stddev !== 'function') {
  (Math as any).stddev = function(arr: number[]): number {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  };
}