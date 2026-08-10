/**
 * Unconscious Sync — embeds perception frames into the collective unconscious.
 *
 * Every ReferenceFrame gets embedded as a vector in a semantic space.
 * This allows "fuzzy" queries that traditional databases can't do:
 *
 *   "What did the grounds look like when we were catching chum?"
 *   "Show me sounder frames similar to this one"
 *   "What's the vibe of the water column right now compared to yesterday?"
 *
 * The JEPA (Joint Embedding Predictive Architecture) predictor can
 * forecast future frames based on the sequence of recent frames:
 *   "Based on the last 5 frames, biomass is likely to concentrate
 *    in the next 20 minutes"
 *
 * Integration with collective-unconscious:
 *   This module provides the embedding interface. The actual vector
 *   store and JEPA model live in the collective-unconscious service.
 *   This module serializes frames into the format that the embedding
 *   pipeline expects.
 *
 * Architecture:
 *   1. Frame → text description (natural language summary)
 *   2. Text description → embedding vector (via embedding model)
 *   3. Embedding vector → vector store (for similarity search)
 *   4. Sequence of embeddings → JEPA predictor (for forecasting)
 *
 * The embedding captures the "essence" of a frame — the overall pattern
 * of fish, feed, bottom, and conditions — in a way that makes similar
 * situations findable even when the exact details differ.
 */

import { ReferenceFrame, Observation, summarizeFrame } from './reference-frame';

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

/**
 * An embedded frame — a perception stored in vector space.
 */
export interface EmbeddedFrame {
  /** Original frame ID */
  frameId: string;

  /** Natural language description (for embedding) */
  description: string;

  /** Embedding vector (from embedding model) */
  embedding: number[];

  /** Key features extracted from the frame */
  features: FrameFeatures;

  /** Outcome label (did this lead to a catch?) */
  outcome?: {
    caught: boolean;
    species?: string;
    minutesToCatch?: number;
  };

  /** Timestamp */
  timestamp: string;
}

/**
 * Structured features extracted from a frame for ML.
 * These are the "labels" that enable supervised learning.
 */
export interface FrameFeatures {
  // Position
  lat: number;
  lon: number;

  // Depth
  currentDepth: number;
  insideOperatingRange: boolean;
  distanceToShallow: number;

  // Speed
  sog: number;
  cog: number;

  // Observations
  fishMarkCount: number;
  fishMarkDepths: number[];
  fishMarkAvgIntensity: number;
  feedBallCount: number;
  feedBallDepths: number[];
  planktonPresent: boolean;
  planktonDepth?: number;
  thermoclinePresent: boolean;
  thermoclineDepth?: number;
  bottomType?: string;
  interferencePresent: boolean;

  // Environment
  seaTemp?: number;
  windSpeed?: number;
  windDir?: number;

  // Derived
  biomassEstimate: number; // 0-1, rough estimate from observations
  activityLevel: number;   // 0-1, how much is happening
  trendIndicator: number;  // -1 (decreasing) to 1 (increasing)
}

/**
 * Similarity search result.
 */
export interface SimilarFrameResult {
  frame: EmbeddedFrame;
  similarity: number; // 0-1
}

/**
 * A prediction from the JEPA model.
 */
export interface JEPAPrediction {
  /** What is predicted */
  prediction: string;

  /** Confidence (0-1) */
  confidence: number;

  /** Time horizon in minutes */
  horizonMinutes: number;

  /** The sequence of frames the prediction is based on */
  basedOnFrameIds: string[];

  /** Predicted features */
  predictedFeatures?: Partial<FrameFeatures>;
}

/**
 * Configuration for the unconscious sync.
 */
export interface UnconsciousConfig {
  /** Endpoint for the embedding service */
  embeddingEndpoint?: string;

  /** Endpoint for the vector store */
  vectorStoreEndpoint?: string;

  /** Endpoint for the JEPA predictor */
  jepaEndpoint?: string;

  /** Embedding model name */
  embeddingModel?: string;

  /** Whether to store embeddings locally (fallback if no vector store) */
  localStore: boolean;

  /** Path for local embedding store */
  localStorePath: string;
}

export const DEFAULT_UNCONSCIOUS_CONFIG: UnconsciousConfig = {
  localStore: true,
  localStorePath: './data/embeddings.json',
};

// ──────────────────────────────────────────────────────────────
// Frame → Description (for embedding)
// ──────────────────────────────────────────────────────────────

/**
 * Convert a ReferenceFrame into a natural language description.
 *
 * This description is what gets embedded. It captures the "vibe"
 * of the frame in human-readable terms, which helps the embedding
 * model create meaningful semantic relationships.
 *
 * Example output:
 *   "Fishing at 58.3N 134.5W, depth 54 fathoms on the deep side
 *    of the 51 line. 8 fish marks at 30-45 fathoms, 2 feed balls
 *    at 35 fathoms. Plankton layer at 25 fathoms. Hard bottom.
 *    Making 2.3 knots SOG. Moderate activity, biomass concentrated
 *    mid-water. No interference. No catches."
 */
export function frameToDescription(frame: ReferenceFrame): string {
  const parts: string[] = [];

  // Location and depth
  parts.push(
    `Position ${frame.position.lat.toFixed(3)}N ${frame.position.lon.toFixed(3)}W`,
  );
  parts.push(`depth ${frame.depthRelationship.currentDepth.toFixed(0)} fathoms`);
  parts.push(
    frame.depthRelationship.insideOperatingRange
      ? 'on the deep side of the 51 line'
      : 'on the shallow side of the 51 line',
  );

  // Speed
  parts.push(`${frame.speedAndHeading.sog.toFixed(1)} knots SOG`);

  // Observations by type
  const byType: Record<string, Observation[]> = {};
  for (const obs of frame.observations) {
    if (!byType[obs.type]) byType[obs.type] = [];
    byType[obs.type].push(obs);
  }

  if (byType.fish_mark) {
    const depths = byType.fish_mark.map((o) => o.depth);
    const minD = Math.min(...depths).toFixed(0);
    const maxD = Math.max(...depths).toFixed(0);
    parts.push(`${byType.fish_mark.length} fish marks at ${minD}-${maxD} fathoms`);
  }

  if (byType.feed_ball) {
    const depths = byType.feed_ball.map((o) => o.depth.toFixed(0));
    parts.push(`${byType.feed_ball.length} feed balls at ${depths.join(', ')} fathoms`);
  }

  if (byType.plankton_layer) {
    const depth = byType.plankton_layer[0].depth.toFixed(0);
    parts.push(`plankton layer at ${depth} fathoms`);
  }

  if (byType.thermocline) {
    parts.push(`thermocline at ${byType.thermocline[0].depth.toFixed(0)} fathoms`);
  }

  if (byType.bottom_type) {
    parts.push(byType.bottom_type[0].description);
  }

  if (byType.gear_tracking) {
    const gear = byType.gear_tracking[0];
    if (gear.description.includes('ABNORMAL')) {
      parts.push('gear showing abnormal pattern');
    } else {
      parts.push('gear tracking normally');
    }
  }

  // Interference
  if (frame.interferencePatterns && frame.interferencePatterns.length > 0) {
    parts.push(`interference detected (${frame.interferencePatterns[0].recommendation})`);
  }

  // Catch
  if (frame.catchEvents && frame.catchEvents.length > 0) {
    const species = frame.catchEvents.map((c) => c.species).join(', ');
    parts.push(`CAUGHT ${species}`);
  }

  // Environment
  if (frame.seaTemp !== undefined) {
    parts.push(`sea temp ${frame.seaTemp.toFixed(1)}°C`);
  }
  if (frame.wind) {
    parts.push(`wind ${frame.wind.speedKnots.toFixed(0)} kt from ${frame.wind.directionDegrees.toFixed(0)}°`);
  }

  return parts.join('. ');
}

/**
 * Extract structured features from a frame for ML.
 */
export function extractFeatures(frame: ReferenceFrame): FrameFeatures {
  const fishMarks = frame.observations.filter((o) => o.type === 'fish_mark');
  const feedBalls = frame.observations.filter((o) => o.type === 'feed_ball');
  const plankton = frame.observations.find((o) => o.type === 'plankton_layer');
  const thermocline = frame.observations.find((o) => o.type === 'thermocline');
  const bottomType = frame.observations.find((o) => o.type === 'bottom_type');
  const interference = frame.interferencePatterns?.length ?? 0 > 0;

  // Biomass estimate: weighted combination of observations
  const biomassEstimate = Math.min(
    1.0,
    fishMarks.length * 0.08 +
      feedBalls.length * 0.15 +
      (plankton ? 0.1 : 0) +
      (thermocline ? 0.05 : 0),
  );

  // Activity level: how much is happening
  const activityLevel = Math.min(
    1.0,
    frame.observations.length * 0.1,
  );

  // Trend indicator (needs sequence context — approximate from current frame)
  const trendIndicator = frame.depthRelationship.nearestShallow > 5 ? 0.2
    : frame.depthRelationship.nearestShallow < -5 ? -0.2
    : 0;

  return {
    lat: frame.position.lat,
    lon: frame.position.lon,
    currentDepth: frame.depthRelationship.currentDepth,
    insideOperatingRange: frame.depthRelationship.insideOperatingRange,
    distanceToShallow: frame.depthRelationship.nearestShallow,
    sog: frame.speedAndHeading.sog,
    cog: frame.speedAndHeading.cog,
    fishMarkCount: fishMarks.length,
    fishMarkDepths: fishMarks.map((o) => o.depth),
    fishMarkAvgIntensity: fishMarks.length > 0
      ? fishMarks.reduce((s, o) => s + o.intensity, 0) / fishMarks.length
      : 0,
    feedBallCount: feedBalls.length,
    feedBallDepths: feedBalls.map((o) => o.depth),
    planktonPresent: !!plankton,
    planktonDepth: plankton?.depth,
    thermoclinePresent: !!thermocline,
    thermoclineDepth: thermocline?.depth,
    bottomType: bottomType?.description.includes('hard') ? 'hard'
      : bottomType?.description.includes('weed') ? 'weed'
      : bottomType?.description.includes('soft') ? 'soft'
      : undefined,
    interferencePresent: interference,
    seaTemp: frame.seaTemp,
    windSpeed: frame.wind?.speedKnots,
    windDir: frame.wind?.directionDegrees,
    biomassEstimate: Math.round(biomassEstimate * 100) / 100,
    activityLevel: Math.round(activityLevel * 100) / 100,
    trendIndicator,
  };
}

// ──────────────────────────────────────────────────────────────
// UnconsciousSync
// ──────────────────────────────────────────────────────────────

/**
 * Manages the embedding and retrieval of perception frames in
 * the collective unconscious.
 *
 * Usage:
 *   const sync = new UnconsciousSync();
 *   await sync.init();
 *   await sync.embed(frame);
 *   const similar = await sync.findSimilar(frame, 5);
 *   const prediction = await sync.predict([frame1, frame2, frame3]);
 */
export class UnconsciousSync {
  private config: UnconsciousConfig;
  private localStore: Map<string, EmbeddedFrame> = new Map();
  private initialized = false;

  constructor(config?: Partial<UnconsciousConfig>) {
    this.config = { ...DEFAULT_UNCONSCIOUS_CONFIG, ...config };
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    if (this.config.localStore) {
      // Load local store if it exists
      try {
        const { readFileSync } = require('fs');
        const data = JSON.parse(
          readFileSync(this.config.localStorePath, 'utf-8'),
        );
        if (Array.isArray(data)) {
          for (const entry of data) {
            this.localStore.set(entry.frameId, entry);
          }
        }
        console.log(`[UnconsciousSync] Loaded ${this.localStore.size} embedded frames`);
      } catch {
        // No existing store — start fresh
        console.log('[UnconsciousSync] Starting with empty store');
      }
    }

    this.initialized = true;
  }

  /**
   * Embed a frame into the collective unconscious.
   */
  async embed(
    frame: ReferenceFrame,
    outcome?: { caught: boolean; species?: string; minutesToCatch?: number },
  ): Promise<EmbeddedFrame> {
    if (!this.initialized) await this.init();

    const description = frameToDescription(frame);
    const features = extractFeatures(frame);

    // Generate embedding (would call embedding API in production)
    const embedding = await this.generateEmbedding(description);

    const embedded: EmbeddedFrame = {
      frameId: frame.frameId,
      description,
      embedding,
      features,
      outcome,
      timestamp: frame.timestamp,
    };

    // Store
    if (this.config.localStore) {
      this.localStore.set(frame.frameId, embedded);
      await this.persistLocal();
    }

    // Remote vector store
    if (this.config.vectorStoreEndpoint) {
      await this.storeRemote(embedded);
    }

    return embedded;
  }

  /**
   * Find frames similar to the given query frame.
   *
   * "Show me sounder frames similar to this one"
   */
  async findSimilar(
    frame: ReferenceFrame,
    limit: number = 5,
  ): Promise<SimilarFrameResult[]> {
    if (!this.initialized) await this.init();

    const queryEmbedding = await this.generateEmbedding(
      frameToDescription(frame),
    );

    // Local similarity search (cosine similarity)
    if (this.config.localStore) {
      const results: SimilarFrameResult[] = [];

      for (const [id, embedded] of this.localStore) {
        const similarity = cosineSimilarity(queryEmbedding, embedded.embedding);
        results.push({ frame: embedded, similarity });
      }

      results.sort((a, b) => b.similarity - a.similarity);
      return results.slice(0, limit);
    }

    // Remote vector store query
    if (this.config.vectorStoreEndpoint) {
      return await this.queryRemote(queryEmbedding, limit);
    }

    return [];
  }

  /**
   * Find frames by natural language query.
   *
   * "What did the grounds look like when we were catching chum?"
   */
  async search(
    query: string,
    limit: number = 10,
  ): Promise<SimilarFrameResult[]> {
    if (!this.initialized) await this.init();

    const queryEmbedding = await this.generateEmbedding(query);

    const results: SimilarFrameResult[] = [];

    for (const [, embedded] of this.localStore) {
      const similarity = cosineSimilarity(queryEmbedding, embedded.embedding);
      results.push({ frame: embedded, similarity });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  /**
   * Predict what's coming next based on recent frames.
   *
   * "Based on the last 5 frames, biomass is likely to concentrate
   *  in the next 20 minutes"
   *
   * This calls the JEPA predictor (if available) or falls back to
   * a heuristic based on frame-to-frame trends.
   */
  async predict(
    recentFrames: ReferenceFrame[],
    horizonMinutes: number = 20,
  ): Promise<JEPAPrediction> {
    if (recentFrames.length < 2) {
      return {
        prediction: 'Not enough data for prediction',
        confidence: 0,
        horizonMinutes,
        basedOnFrameIds: recentFrames.map((f) => f.frameId),
      };
    }

    // JEPA remote prediction
    if (this.config.jepaEndpoint) {
      try {
        return await this.predictRemote(recentFrames, horizonMinutes);
      } catch (error) {
        console.warn('[UnconsciousSync] JEPA remote failed, using heuristic:', error);
      }
    }

    // Heuristic prediction based on trends
    return this.heuristicPredict(recentFrames, horizonMinutes);
  }

  /**
   * Get all embedded frames (for batch ML training).
   */
  getAllEmbeddings(): EmbeddedFrame[] {
    return Array.from(this.localStore.values());
  }

  /**
   * Get embedding statistics.
   */
  getStats(): {
    totalEmbedded: number;
    withOutcome: number;
    catchesEmbedded: number;
    avgBiomass: number;
  } {
    const all = Array.from(this.localStore.values());
    const withOutcome = all.filter((e) => e.outcome !== undefined);
    const catches = withOutcome.filter((e) => e.outcome?.caught);

    return {
      totalEmbedded: all.length,
      withOutcome: withOutcome.length,
      catchesEmbedded: catches.length,
      avgBiomass: all.length > 0
        ? all.reduce((s, e) => s + e.features.biomassEstimate, 0) / all.length
        : 0,
    };
  }

  // ── Private methods ──────────────────────────────────────────

  /**
   * Generate an embedding vector from a text description.
   * Uses a lightweight hash-based embedding as fallback.
   * In production, this would call the embedding API (BAAI/bge-m3 or similar).
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    // If we have an embedding endpoint, use it
    if (this.config.embeddingEndpoint) {
      try {
        const response = await fetch(this.config.embeddingEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            model: this.config.embeddingModel ?? 'BAAI/bge-m3',
          }),
        });
        if (response.ok) {
          const data = await response.json() as { embedding: number[] };
          return data.embedding;
        }
      } catch {
        // Fall through to hash-based
      }
    }

    // Hash-based pseudo-embedding (deterministic but not semantic)
    // This is a placeholder — real embeddings need a real model
    const dimensions = 128;
    const embedding = new Array(dimensions).fill(0);

    // Simple feature hashing
    const words = text.toLowerCase().split(/[\s.,]+/);
    for (const word of words) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }
      const idx = Math.abs(hash) % dimensions;
      embedding[idx] += 1;
    }

    // Normalize
    const magnitude = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < dimensions; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
  }

  /**
   * Heuristic-based prediction (fallback when JEPA is unavailable).
   */
  private heuristicPredict(
    frames: ReferenceFrame[],
    horizonMinutes: number,
  ): JEPAPrediction {
    const recent = frames.slice(-5);
    const featuresList = recent.map(extractFeatures);

    // Analyze trends
    const biomassTrend = featuresList.length >= 2
      ? featuresList[featuresList.length - 1].biomassEstimate -
        featuresList[0].biomassEstimate
      : 0;

    const activityTrend = featuresList.length >= 2
      ? featuresList[featuresList.length - 1].activityLevel -
        featuresList[0].activityLevel
      : 0;

    const feedBallIncreasing = featuresList.length >= 2
      ? featuresList[featuresList.length - 1].feedBallCount >
        featuresList[0].feedBallCount
      : false;

    const lastFrame = recent[recent.length - 1];
    const lastFeatures = featuresList[featuresList.length - 1];

    let prediction: string;
    let confidence: number;

    if (biomassTrend > 0.1 && activityTrend > 0.1) {
      prediction = `Biomass increasing, activity rising. Feed may concentrate in the next ${horizonMinutes} minutes. Watch for catch opportunities.`;
      confidence = Math.min(0.7, biomassTrend * 2);
    } else if (feedBallIncreasing) {
      prediction = `Feed balls forming. Predator activity likely to increase. Stay on current tack.`;
      confidence = 0.55;
    } else if (biomassTrend < -0.1) {
      prediction = `Biomass decreasing. Consider relocating or adjusting gear depth.`;
      confidence = 0.5;
    } else if (lastFeatures.biomassEstimate > 0.4) {
      prediction = `Steady biomass at ${(lastFeatures.biomassEstimate * 100).toFixed(0)}%. Conditions holding. Continue current pattern.`;
      confidence = 0.6;
    } else {
      prediction = `Low activity. No strong trend detected. Continue monitoring.`;
      confidence = 0.3;
    }

    return {
      prediction,
      confidence: Math.round(confidence * 100) / 100,
      horizonMinutes,
      basedOnFrameIds: recent.map((f) => f.frameId),
      predictedFeatures: {
        biomassEstimate: Math.max(0, Math.min(1,
          lastFeatures.biomassEstimate + biomassTrend)),
        activityLevel: Math.max(0, Math.min(1,
          lastFeatures.activityLevel + activityTrend)),
      },
    };
  }

  private async persistLocal(): Promise<void> {
    if (!this.config.localStore) return;

    const { writeFileSync, mkdirSync } = require('fs');
    const { dirname } = require('path');

    try {
      mkdirSync(dirname(this.config.localStorePath), { recursive: true });
      writeFileSync(
        this.config.localStorePath,
        JSON.stringify(Array.from(this.localStore.values()), null, 2),
      );
    } catch (error) {
      console.error('[UnconsciousSync] Failed to persist:', error);
    }
  }

  private async storeRemote(embedded: EmbeddedFrame): Promise<void> {
    // Would POST to vector store endpoint
    // Placeholder for now
  }

  private async queryRemote(
    embedding: number[],
    limit: number,
  ): Promise<SimilarFrameResult[]> {
    // Would query vector store endpoint
    return [];
  }

  private async predictRemote(
    frames: ReferenceFrame[],
    horizonMinutes: number,
  ): Promise<JEPAPrediction> {
    // Would call JEPA endpoint
    throw new Error('Not implemented');
  }
}

// ──────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  const denom = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
  return denom > 0 ? dotProduct / denom : 0;
}
