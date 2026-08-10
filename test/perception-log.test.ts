/**
 * Hermes Perception — PerceptionLog Tests
 *
 * Tests the SQLite-backed perception log with a temporary database.
 * Covers initialization, logging frames, querying, and catch correlation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PerceptionLog } from '../src/perception-log';
import type { ReferenceFrame, Observation } from '../src/reference-frame';
import { promises as fs } from 'fs';
import { join } from 'path';
import os from 'os';

// Helper: create a minimal ReferenceFrame
function makeFrame(overrides: Partial<ReferenceFrame> = {}): ReferenceFrame {
  return {
    timestamp: new Date().toISOString(),
    frameId: `test-${Math.random().toString(36).slice(2, 10)}`,
    position: { lat: 58.3, lon: -149.5 },
    speedAndHeading: { sog: 5.5, cog: 180 },
    depthRelationship: {
      currentDepth: 51,
      gearDepth: 51,
      insideOperatingRange: true,
      redContourDepth: 51,
      depthOffset: 0,
    },
    observations: [],
    source: 'test',
    ...overrides,
  } as ReferenceFrame;
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    type: 'fish_mark',
    depth: 35,
    intensity: 0.7,
    confidence: 0.8,
    description: 'test observation',
    frequency: 'high',
    ...overrides,
  };
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'hermes-test-'));
});

afterAll(async () => {
  // Clean up temp files
  try {
    const files = await fs.readdir(tmpDir);
    await Promise.all(files.map((f) => fs.unlink(join(tmpDir, f))));
    await fs.rmdir(tmpDir);
  } catch {
    // Ignore cleanup errors
  }
});

describe('PerceptionLog', () => {
  let log: PerceptionLog;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    log = new PerceptionLog(dbPath);
    await log.init();
  });

  describe('init', () => {
    it('should create the database file', async () => {
      const stats = await fs.stat(dbPath);
      expect(stats.isFile()).toBe(true);
    });

    it('should be idempotent (calling init twice is safe)', async () => {
      await log.init(); // second call
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('log', () => {
    it('should store a frame with no observations', async () => {
      const frame = makeFrame();
      await log.log(frame);

      const results = await log.query({});
      expect(results).toHaveLength(1);
      // SQL columns use snake_case
      expect((results[0] as any).frame_id ?? results[0].frameId).toBe(frame.frameId);
    });

    it('should store a frame with observations', async () => {
      const frame = makeFrame({
        observations: [
          makeObservation({ type: 'fish_mark', depth: 35 }),
          makeObservation({ type: 'feed_ball', depth: 28 }),
          makeObservation({ type: 'plankton_layer', depth: 40 }),
        ],
      });

      await log.log(frame);

      const results = await log.query({});
      expect(results).toHaveLength(1);
      expect((results[0] as any).observation_count ?? results[0].observationCount).toBe(3);
    });

    it('should store multiple frames', async () => {
      for (let i = 0; i < 5; i++) {
        await log.log(makeFrame({
          frameId: `frame-${i}`,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
        }));
      }

      const results = await log.query({});
      expect(results).toHaveLength(5);
    });

    it('should store frame with catch event flag', async () => {
      const frame = makeFrame({
        catchEvents: [{
          species: 'king',
          gearNumber: 2,
          timestamp: new Date().toISOString(),
          lat: 58.3,
          lon: -149.5,
          weight: 25,
          length: 90,
        }] as any,
      });

      await log.log(frame);
      const results = await log.query({});
      expect((results[0] as any).has_catch_event ?? results[0].hasCatchEvent).toBeTruthy();
    });

    it('should store frame with interference flag', async () => {
      const frame = makeFrame({
        interferencePatterns: [{
          type: 'vertical_lines',
          severity: 0.5,
          description: 'test interference',
          confidence: 0.7,
          timestamp: Date.now(),
        }] as any,
      });

      await log.log(frame);
      const results = await log.query({});
      expect((results[0] as any).has_interference ?? results[0].hasInterference).toBeTruthy();
    });

    it('should preserve the full frame JSON', async () => {
      const frame = makeFrame({ observations: [makeObservation()] });
      await log.log(frame);

      const results = await log.query({});
      const jsonField = (results[0] as any).frame_json ?? results[0].frameJson;
      const parsed = JSON.parse(jsonField);
      expect(parsed.frameId).toBe(frame.frameId);
      expect(parsed.observations).toHaveLength(1);
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      // Seed with known data
      const baseTime = new Date('2026-08-10T00:00:00Z');
      for (let i = 0; i < 10; i++) {
        await log.log(makeFrame({
          frameId: `qframe-${i}`,
          timestamp: new Date(baseTime.getTime() + i * 60000).toISOString(),
          position: { lat: 58.0 + i * 0.01, lon: -149.5 + i * 0.01 },
          depthRelationship: {
            currentDepth: 40 + i * 2,
            gearDepth: 51,
            insideOperatingRange: i > 2,
            redContourDepth: 51,
            depthOffset: 0,
          } as any,
          observations: i % 3 === 0
            ? [makeObservation({ type: 'fish_mark', confidence: 0.9 })]
            : [],
        }));
      }
    });

    it('should return all frames with empty query', async () => {
      const results = await log.query({});
      expect(results.length).toBe(10);
    });

    it('should filter by time range', async () => {
      const results = await log.query({
        startTime: '2026-08-10T00:03:00Z',
        endTime: '2026-08-10T00:07:00Z',
      });
      expect(results.length).toBeGreaterThanOrEqual(3);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('should filter by observation type', async () => {
      const results = await log.query({
        observationType: 'fish_mark',
      });
      // Only every 3rd frame has fish_mark (i=0,3,6,9)
      expect(results.length).toBe(4);
    });

    it('should sort by time ascending', async () => {
      const results = await log.query({ sort: 'time_asc' });
      const firstId = (results[0] as any).frame_id ?? results[0].frameId;
      expect(firstId).toBe('qframe-0');
    });

    it('should sort by time descending', async () => {
      const results = await log.query({ sort: 'time_desc' });
      const firstId = (results[0] as any).frame_id ?? results[0].frameId;
      expect(firstId).toBe('qframe-9');
    });

    it('should limit results', async () => {
      const results = await log.query({ limit: 3 });
      expect(results.length).toBe(3);
    });
  });

  describe('getStats', () => {
    it('should report database statistics', async () => {
      await log.log(makeFrame({ frameId: 'stat-1' }));
      await log.log(makeFrame({
        frameId: 'stat-2',
        catchEvents: [{ species: 'king', gearNumber: 1, timestamp: new Date().toISOString(), lat: 58, lon: -149 }] as any,
      }));

      const stats = await log.getStats();
      expect(stats.totalFrames).toBeGreaterThanOrEqual(2);
    });
  });

  describe('close', () => {
    it('should close the database cleanly', async () => {
      await log.log(makeFrame());
      log.close();
      // Creating a new log on the same path should work
      const log2 = new PerceptionLog(dbPath);
      await log2.init();
      const results = await log2.query({});
      expect(results.length).toBeGreaterThanOrEqual(1);
      log2.close();
    });
  });
});
