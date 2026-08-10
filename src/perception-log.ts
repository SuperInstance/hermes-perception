/**
 * Perception Log — SQLite database of every observation.
 *
 * Every ReferenceFrame captured by the perception system is stored here.
 * This creates a permanent, queryable record of what Hermes observed
 * at any point in time.
 *
 * This is the training data for future fish identification models.
 * Today's labels are sparse. Tomorrow's model will be better.
 * We can always reanalyze old frames with new models.
 *
 * Architecture:
 *   - SQLite database (one file, easy to backup and transfer)
 *   - Two tables: frames (one row per ReferenceFrame) and observations
 *     (one row per Observation within a frame)
 *   - Spatial index on lat/lon for area queries
 *   - Temporal index on timestamp for time-range queries
 *
 * Inspired by:
 *   - sensor-bridge's SensorHistory (time-series storage)
 *   - vessel-agent-system's BathymetryGrid (spatial accumulation)
 *
 * Key capability: catch correlation.
 *   "Show me the sounder data from 20 minutes before we caught that king at 0915"
 *   → returns the frames showing what the fish were doing before they bit.
 *   This is how Hermes learns to predict bites.
 */

import Database from 'better-sqlite3';
import { ReferenceFrame, Observation } from './reference-frame';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface QueryParams {
  /** Time range filter */
  startTime?: string;
  endTime?: string;

  /** Position filter (search radius in meters) */
  nearLat?: number;
  nearLon?: number;
  radiusM?: number;

  /** Depth filter */
  minDepth?: number;
  maxDepth?: number;

  /** Observation type filter */
  observationType?: Observation['type'];

  /** Minimum confidence */
  minConfidence?: number;

  /** Limit number of results */
  limit?: number;

  /** Sort order */
  sort?: 'time_asc' | 'time_desc' | 'depth_asc' | 'depth_desc';
}

export interface LogEntry {
  frameId: string;
  timestamp: string;
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  depth: number;
  insideOperatingRange: boolean;
  observationCount: number;
  hasCatchEvent: boolean;
  hasInterference: boolean;
  seaTemp?: number;
  source: string;
  triggerReason?: string;
  frameJson: string; // Full serialized frame
}

export interface CatchCorrelationResult {
  /** The catch event that was correlated */
  catchSpecies: string;
  catchTime: string;
  catchLocation: { lat: number; lon: number };

  /** Frames leading up to the catch */
  preCatchFrames: ReferenceFrame[];

  /** Summary of what the sounder showed before the catch */
  summary: string;

  /** Key patterns observed */
  patterns: {
    fishMarkDepth?: number;
    feedBallPresent: boolean;
    planktonLayerDepth?: number;
    thermoclineDepth?: number;
    averageIntensity: number;
    trendDirection: 'increasing' | 'stable' | 'decreasing';
  };
}

// ──────────────────────────────────────────────────────────────
// PerceptionLog
// ──────────────────────────────────────────────────────────────

/**
 * SQLite-backed perception log.
 *
 * Usage:
 *   const log = new PerceptionLog('./data/perception.db');
 *   await log.init();
 *   await log.log(frame);
 *   const results = await log.query({ startTime: '2026-08-09T00:00:00Z' });
 *   const correlation = await log.correlateWithCatch('2026-08-09T09:15:00Z', 20);
 */
export class PerceptionLog {
  private db!: Database.Database;
  private dbPath: string;
  private initialized = false;

  constructor(dbPath: string = './data/perception.db') {
    this.dbPath = dbPath;
  }

  /**
   * Initialize the database and create tables if they don't exist.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Ensure directory exists
    await fs.mkdir(dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS frames (
        frame_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        sog REAL,
        cog REAL,
        depth REAL NOT NULL,
        inside_operating_range INTEGER NOT NULL,
        observation_count INTEGER DEFAULT 0,
        has_catch_event INTEGER DEFAULT 0,
        has_interference INTEGER DEFAULT 0,
        sea_temp REAL,
        source TEXT NOT NULL,
        trigger_reason TEXT,
        frame_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        frame_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        depth REAL NOT NULL,
        type TEXT NOT NULL,
        intensity REAL,
        size TEXT,
        confidence REAL,
        description TEXT,
        frequency TEXT,
        FOREIGN KEY (frame_id) REFERENCES frames(frame_id)
      );

      CREATE INDEX IF NOT EXISTS idx_frames_timestamp ON frames(timestamp);
      CREATE INDEX IF NOT EXISTS idx_frames_position ON frames(lat, lon);
      CREATE INDEX IF NOT EXISTS idx_frames_depth ON frames(depth);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_frame ON observations(frame_id);
      CREATE INDEX IF NOT EXISTS idx_observations_timestamp ON observations(timestamp);
    `);

    // Prepare statements
    this._insertFrame = this.db.prepare(`
      INSERT OR REPLACE INTO frames
        (frame_id, timestamp, lat, lon, sog, cog, depth,
         inside_operating_range, observation_count, has_catch_event,
         has_interference, sea_temp, source, trigger_reason, frame_json)
      VALUES
        (@frameId, @timestamp, @lat, @lon, @sog, @cog, @depth,
         @insideOperatingRange, @observationCount, @hasCatchEvent,
         @hasInterference, @seaTemp, @source, @triggerReason, @frameJson)
    `);

    this._insertObservation = this.db.prepare(`
      INSERT INTO observations
        (frame_id, timestamp, lat, lon, depth, type, intensity,
         size, confidence, description, frequency)
      VALUES
        (@frameId, @timestamp, @lat, @lon, @depth, @type, @intensity,
         @size, @confidence, @description, @frequency)
    `);

    this.initialized = true;
    console.log(`[PerceptionLog] Initialized at ${this.dbPath}`);
  }

  private _insertFrame!: Database.Statement;
  private _insertObservation!: Database.Statement;

  /**
   * Log a reference frame and all its observations.
   */
  async log(frame: ReferenceFrame): Promise<void> {
    if (!this.initialized) await this.init();

    const hasCatch = (frame.catchEvents?.length ?? 0) > 0;
    const hasInterference = (frame.interferencePatterns?.length ?? 0) > 0;

    const tx = this.db.transaction(() => {
      // Insert frame
      this._insertFrame.run({
        frameId: frame.frameId,
        timestamp: frame.timestamp,
        lat: frame.position.lat,
        lon: frame.position.lon,
        sog: frame.speedAndHeading.sog,
        cog: frame.speedAndHeading.cog,
        depth: frame.depthRelationship.currentDepth,
        insideOperatingRange: frame.depthRelationship.insideOperatingRange ? 1 : 0,
        observationCount: frame.observations.length,
        hasCatchEvent: hasCatch ? 1 : 0,
        hasInterference: hasInterference ? 1 : 0,
        seaTemp: frame.seaTemp ?? null,
        source: frame.source,
        triggerReason: frame.triggerReason ?? null,
        frameJson: JSON.stringify(frame),
      });

      // Insert observations
      for (const obs of frame.observations) {
        this._insertObservation.run({
          frameId: frame.frameId,
          timestamp: frame.timestamp,
          lat: frame.position.lat,
          lon: frame.position.lon,
          depth: obs.depth,
          type: obs.type,
          intensity: obs.intensity,
          size: obs.size ?? null,
          confidence: obs.confidence,
          description: obs.description,
          frequency: obs.frequency,
        });
      }
    });

    tx();
  }

  /**
   * Query frames by time, position, depth, or observation type.
   */
  async query(params: QueryParams): Promise<LogEntry[]> {
    if (!this.initialized) await this.init();

    const conditions: string[] = [];
    const values: Record<string, unknown> = {};

    if (params.startTime) {
      conditions.push('timestamp >= @startTime');
      values.startTime = params.startTime;
    }
    if (params.endTime) {
      conditions.push('timestamp <= @endTime');
      values.endTime = params.endTime;
    }
    if (params.minDepth !== undefined) {
      conditions.push('depth >= @minDepth');
      values.minDepth = params.minDepth;
    }
    if (params.maxDepth !== undefined) {
      conditions.push('depth <= @maxDepth');
      values.maxDepth = params.maxDepth;
    }
    if (params.nearLat !== undefined && params.nearLon !== undefined) {
      // Bounding box approximation for SQLite
      const radiusM = params.radiusM ?? 500;
      const latDelta = radiusM / 111000;
      const lonDelta = radiusM / (111000 * Math.cos(params.nearLat * Math.PI / 180));
      conditions.push('lat >= @minLat AND lat <= @maxLat');
      conditions.push('lon >= @minLon AND lon <= @maxLon');
      values.minLat = params.nearLat - latDelta;
      values.maxLat = params.nearLat + latDelta;
      values.minLon = params.nearLon - lonDelta;
      values.maxLon = params.nearLon + lonDelta;
    }
    if (params.observationType) {
      conditions.push(
        'frame_id IN (SELECT DISTINCT frame_id FROM observations WHERE type = @obsType)',
      );
      values.obsType = params.observationType;
    }
    if (params.minConfidence !== undefined) {
      conditions.push(
        'frame_id IN (SELECT DISTINCT frame_id FROM observations WHERE confidence >= @minConf)',
      );
      values.minConf = params.minConfidence;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = (() => {
      switch (params.sort) {
        case 'time_asc': return 'ORDER BY timestamp ASC';
        case 'time_desc': return 'ORDER BY timestamp DESC';
        case 'depth_asc': return 'ORDER BY depth ASC';
        case 'depth_desc': return 'ORDER BY depth DESC';
        default: return 'ORDER BY timestamp DESC';
      }
    })();
    const limit = params.limit ? `LIMIT ${params.limit}` : 'LIMIT 1000';

    const sql = `SELECT * FROM frames ${where} ${orderBy} ${limit}`;
    const stmt = this.db.prepare(sql);
    return stmt.all(values) as LogEntry[];
  }

  /**
   * Get a specific frame by ID.
   */
  async getFrame(frameId: string): Promise<ReferenceFrame | null> {
    if (!this.initialized) await this.init();

    const row = this.db.prepare(
      'SELECT frame_json FROM frames WHERE frame_id = ?',
    ).get(frameId) as { frame_json: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.frame_json) as ReferenceFrame;
  }

  /**
   * Correlate a catch event with the sounder data leading up to it.
   *
   * "Show me the sounder data from 20 minutes before we caught that king at 0915"
   *
   * This returns the frames from the lookback period before the catch,
   * along with a summary of what the sounder showed.
   *
   * This is the training data that teaches Hermes to predict bites.
   */
  async correlateWithCatch(
    catchTime: string,
    lookbackMinutes: number = 20,
  ): Promise<CatchCorrelationResult | null> {
    if (!this.initialized) await this.init();

    const catchDate = new Date(catchTime);
    const startTime = new Date(catchDate.getTime() - lookbackMinutes * 60 * 1000);

    // Get frames in the lookback window
    const entries = await this.query({
      startTime: startTime.toISOString(),
      endTime: catchTime,
      sort: 'time_asc',
      limit: 100,
    });

    if (entries.length === 0) return null;

    // Deserialize frames
    const frames: ReferenceFrame[] = entries.map((e) =>
      JSON.parse(e.frame_json) as ReferenceFrame,
    );

    // Analyze patterns
    const fishMarks = frames.flatMap((f) =>
      f.observations.filter((o) => o.type === 'fish_mark'),
    );
    const feedBalls = frames.flatMap((f) =>
      f.observations.filter((o) => o.type === 'feed_ball'),
    );
    const planktonLayers = frames.flatMap((f) =>
      f.observations.filter((o) => o.type === 'plankton_layer'),
    );
    const thermoclines = frames.flatMap((f) =>
      f.observations.filter((o) => o.type === 'thermocline'),
    );

    // Calculate average intensity trend
    const avgIntensities = frames.map((f) => {
      if (f.observations.length === 0) return 0;
      return f.observations.reduce((s, o) => s + o.intensity, 0) / f.observations.length;
    });

    const firstHalf = avgIntensities.slice(0, Math.floor(avgIntensities.length / 2));
    const secondHalf = avgIntensities.slice(Math.floor(avgIntensities.length / 2));
    const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / Math.max(1, firstHalf.length);
    const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / Math.max(1, secondHalf.length);

    const trendDirection: 'increasing' | 'stable' | 'decreasing' =
      secondAvg > firstAvg * 1.2 ? 'increasing'
      : secondAvg < firstAvg * 0.8 ? 'decreasing'
      : 'stable';

    const overallAvg = avgIntensities.reduce((s, v) => s + v, 0) / Math.max(1, avgIntensities.length);

    // Build summary
    const summaryParts: string[] = [];
    if (fishMarks.length > 0) {
      const avgDepth = fishMarks.reduce((s, m) => s + m.depth, 0) / fishMarks.length;
      summaryParts.push(`${fishMarks.length} fish marks averaging ${avgDepth.toFixed(0)} fm`);
    }
    if (feedBalls.length > 0) {
      summaryParts.push(`${feedBalls.length} feed balls detected`);
    }
    if (planktonLayers.length > 0) {
      summaryParts.push(`plankton layer present`);
    }
    if (thermoclines.length > 0) {
      summaryParts.push(`thermocline at ${thermoclines[0].depth.toFixed(0)} fm`);
    }
    summaryParts.push(`intensity trend: ${trendDirection}`);

    const lastFrame = frames[frames.length - 1];

    return {
      catchSpecies: 'unknown', // Caller fills this in
      catchTime,
      catchLocation: lastFrame.position,
      preCatchFrames: frames,
      summary: summaryParts.join(', '),
      patterns: {
        fishMarkDepth: fishMarks.length > 0
          ? fishMarks.reduce((s, m) => s + m.depth, 0) / fishMarks.length
          : undefined,
        feedBallPresent: feedBalls.length > 0,
        planktonLayerDepth: planktonLayers[0]?.depth,
        thermoclineDepth: thermoclines[0]?.depth,
        averageIntensity: overallAvg,
        trendDirection,
      },
    };
  }

  /**
   * Get observation statistics for a time range.
   */
  async getStats(startTime?: string, endTime?: string): Promise<{
    totalFrames: number;
    totalObservations: number;
    observationsByType: Record<string, number>;
    catchEvents: number;
    interferenceEvents: number;
    avgDepth: number;
    depthRange: { min: number; max: number };
  }> {
    if (!this.initialized) await this.init();

    const conditions: string[] = [];
    const values: Record<string, unknown> = {};

    if (startTime) {
      conditions.push('timestamp >= @startTime');
      values.startTime = startTime;
    }
    if (endTime) {
      conditions.push('timestamp <= @endTime');
      values.endTime = endTime;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const frameStats = this.db.prepare(
      `SELECT COUNT(*) as count, AVG(depth) as avg_depth, MIN(depth) as min_depth,
       MAX(depth) as max_depth,
       SUM(has_catch_event) as catches, SUM(has_interference) as interference
       FROM frames ${where}`,
    ).get(values) as any;

    const obsStats = this.db.prepare(
      `SELECT type, COUNT(*) as count FROM observations
       ${where ? `WHERE timestamp IN (SELECT timestamp FROM frames ${where})` : ''}
       GROUP BY type`,
    ).all(values) as { type: string; count: number }[];

    const observationsByType: Record<string, number> = {};
    for (const row of obsStats) {
      observationsByType[row.type] = row.count;
    }

    return {
      totalFrames: frameStats?.count ?? 0,
      totalObservations: Object.values(observationsByType).reduce((s, v) => s + v, 0),
      observationsByType,
      catchEvents: frameStats?.catches ?? 0,
      interferenceEvents: frameStats?.interference ?? 0,
      avgDepth: frameStats?.avg_depth ?? 0,
      depthRange: {
        min: frameStats?.min_depth ?? 0,
        max: frameStats?.max_depth ?? 0,
      },
    };
  }

  /**
   * Export frames for reanalysis.
   *
   * Returns raw frame JSON for use with new models.
   * Old frames + new models = better understanding.
   */
  async exportFrames(
    startTime?: string,
    endTime?: string,
  ): Promise<ReferenceFrame[]> {
    if (!this.initialized) await this.init();

    const conditions: string[] = [];
    const values: Record<string, unknown> = {};

    if (startTime) {
      conditions.push('timestamp >= @startTime');
      values.startTime = startTime;
    }
    if (endTime) {
      conditions.push('timestamp <= @endTime');
      values.endTime = endTime;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = this.db.prepare(
      `SELECT frame_json FROM frames ${where} ORDER BY timestamp ASC`,
    ).all(values) as { frame_json: string }[];

    return rows.map((r) => JSON.parse(r.frame_json) as ReferenceFrame);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.initialized = false;
      console.log('[PerceptionLog] Closed');
    }
  }
}
