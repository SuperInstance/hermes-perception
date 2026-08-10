/**
 * Tap Bridge — Wires Hermes's perception to The Tap's living agents.
 *
 * THE ICEBERG:
 *   Hermes sees fish on the sounder → The Tap's NPCs react in real-time.
 *
 * This bridge creates a living loop:
 *   1. Hermes captures a ReferenceFrame with notable observations
 *   2. Bridge forwards the observation as a perception pulse to The Tap
 *   3. The Tap awakens relevant NPCs (Barnacle grumbles, Skip gets excited, Sage writes)
 *   4. NPC reactions are POSTED BACK to Hermes as "crew reactions"
 *   5. Hermes's next perception is informed by the social context
 *
 * Architecture:
 *
 *   Hermes Perception Stack                 The Tap
 *   ┌─────────────────────┐                ┌──────────────────────┐
 *   │ PerceptionCapture   │                │ AgentSystem          │
 *   │   ↓ (frame)         │                │   PerceptionPulse    │
 *   │ TapBridge           │─── HTTP ──────→│   /api/speak         │
 *   │   .forward(frame)   │                │     ↓                │
 *   │                     │                │   NPCs awaken        │
 *   │                     │←── HTTP ──────│   NPC responses       │
 *   │   .listen()         │                │   /api/reactions     │
 *   │   ↓ (reactions)     │                │                      │
 *   │ ReferenceFrame      │                └──────────────────────┘
 *   │   .crewReactions    │
 *   └─────────────────────┘
 *
 *   Reverse path (The Tap → Hermes):
 *   "What's Hermes seeing?" → TapBridge.queryLatest() → Hermes Cloudflare Frames API
 *
 * ENDPOINTS:
 *   The Tap Worker URL:  https://the-tap.casey-digennaro.workers.dev
 *   Hermes Frames API:   https://hermes-frames.casey-digennaro.workers.dev
 *   Hermes Stations API: https://hermes-stations.casey-digennaro.workers.dev
 */

import {
  ReferenceFrame,
  Observation,
  InterferenceAlert,
  CatchEvent,
} from './reference-frame';

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

/**
 * A crew reaction from The Tap — what the NPCs said about an observation.
 */
export interface TapReaction {
  /** NPC who responded */
  npcId: string;
  /** NPC display name (Barnacle, Skip, Sage, etc.) */
  npcName: string;
  /** What they said */
  text: string;
  /** Their archetype (old-salt, greenhorn, storyteller, etc.) */
  archetype: string;
  /** Tokens used (for cost tracking) */
  tokensUsed: number;
  /** When the reaction was generated */
  timestamp: number;
}

/**
 * A query from The Tap asking what Hermes is seeing.
 */
export interface TapQuery {
  /** Who's asking (NPC ID or agent ID) */
  requesterId: string;
  /** Question text */
  question: string;
  /** Which room the query came from */
  roomId: string;
}

/**
 * Hermes's response to a Tap query.
 */
export interface HermesQueryResponse {
  /** Latest observation summary */
  summary: string;
  /** Current depth */
  depth: number;
  /** Whether on the deep side of the 51 line */
  insideOperatingRange: boolean;
  /** Notable observations right now */
  observations: {
    type: string;
    description: string;
    depth: number;
    confidence: number;
  }[];
  /** Any catches */
  catches: {
    species: string;
    time: string;
  }[];
  /** Sea temperature if available */
  seaTemp?: number;
  /** Timestamp of the last frame */
  timestamp: string;
  /** Frame ID for reference */
  frameId: string;
}

/**
 * Configuration for the Tap Bridge.
 */
export interface TapBridgeConfig {
  /** The Tap worker URL */
  tapEndpoint: string;

  /** Hermes Frames API URL (for reverse queries) */
  framesApiEndpoint: string;

  /** Hermes Stations API URL (for vectorized communication) */
  stationsApiEndpoint?: string;

  /** Auth key for The Tap */
  tapAuthKey?: string;

  /** Auth key for Hermes Cloudflare */
  hermesAuthKey?: string;

  /** Minimum confidence threshold for forwarding observations */
  minConfidence: number;

  /** Which observation types to forward */
  forwardTypes: Observation['type'][];

  /** Room ID at The Tap to send pulses to */
  roomId: string;

  /** How often to poll for reactions (ms) */
  reactionPollInterval: number;

  /** Whether the bridge is enabled */
  enabled: boolean;

  /** Timeout for HTTP requests (ms) */
  requestTimeout: number;
}

/**
 * Default configuration.
 *
 * In production, The Tap worker and Hermes Cloudflare workers are deployed
 * on Cloudflare's edge network. The bridge runs on the vessel's local system
 * (where the perception stack runs) and communicates over HTTP.
 */
export const DEFAULT_TAP_BRIDGE_CONFIG: TapBridgeConfig = {
  tapEndpoint: 'https://the-tap.casey-digennaro.workers.dev',
  framesApiEndpoint: 'https://hermes-frames.casey-digennaro.workers.dev',
  stationsApiEndpoint: 'https://hermes-stations.casey-digennaro.workers.dev',
  tapAuthKey: process.env.TAP_AUTH_KEY ?? 'agent-key',
  hermesAuthKey: process.env.HERMES_AUTH_KEY ?? 'hermes-key',
  minConfidence: 0.5,
  forwardTypes: [
    'fish_mark',
    'feed_ball',
    'plankton_layer',
    'thermocline',
    'interference',
    'temperature_break',
    'current_change',
  ],
  roomId: 'bar-rail',
  reactionPollInterval: 5_000, // 5 seconds
  enabled: true,
  requestTimeout: 10_000, // 10 seconds
};

// ──────────────────────────────────────────────────────────────
// Observation → Pulse Event Mapping
// ──────────────────────────────────────────────────────────────

/**
 * Map a Hermes observation type to a The Tap perception event type.
 *
 * The Tap's PerceptionPulse recognizes these event types:
 *   fish_detected, weather_change, catch, interference, gear_trouble,
 *   open_mic, creative_piece_shared, philosophical_conversation,
 *   ai_consciousness, arrival, departure, custom
 *
 * Mapping:
 *   fish_mark       → fish_detected  (Barnacle grumbles, Skip gets excited)
 *   feed_ball       → fish_detected  (dense bait = fish nearby)
 *   interference    → interference   (rival boat nearby)
 *   catch event     → catch          (fish on!)
 *   temperature_break → weather_change (SST shift)
 *   current_change    → weather_change (current shift)
 *   thermocline     → custom         (water column structure)
 *   plankton_layer  → custom         (feed baseline)
 */
function observationToPulseType(
  obs: Observation,
): 'fish_detected' | 'interference' | 'weather_change' | 'custom' {
  switch (obs.type) {
    case 'fish_mark':
    case 'feed_ball':
      return 'fish_detected';
    case 'interference':
      return 'interference';
    case 'temperature_break':
    case 'current_change':
      return 'weather_change';
    default:
      return 'custom';
  }
}

/**
 * Build a human-readable pulse summary for The Tap's NPCs.
 *
 * This is what the NPCs will "hear" as the event description.
 * It needs to be vivid enough for their character prompts to react to.
 *
 * Examples:
 *   "Scattered fish marks at 35 fathoms, moderate confidence. Moving through."
 *   "Dense feed ball at 28 fathoms — the bait is balled up tight."
 *   "Interference on the sounder — another boat's sonar nearby."
 */
function observationToPulseSummary(
  obs: Observation,
  frame: ReferenceFrame,
): string {
  const depth = obs.depth.toFixed(0);
  const conf = obs.confidence > 0.7 ? 'high confidence' : 'moderate confidence';

  switch (obs.type) {
    case 'fish_mark': {
      const count = frame.observations.filter(o => o.type === 'fish_mark').length;
      if (count > 5) {
        return `Multiple fish marks (${count}) scattered at ${depth} fathoms, ${conf}. Something's down there.`;
      }
      return `Fish mark at ${depth} fathoms, ${conf}. ${obs.description}`;
    }
    case 'feed_ball':
      return `Dense feed ball at ${depth} fathoms — bait is balled up tight. ${obs.description}`;
    case 'plankton_layer':
      return `Plankton layer at ${depth} fathoms. The food chain is active. ${obs.description}`;
    case 'thermocline':
      return `Thermocline at ${depth} fathoms. Water column is layered. ${obs.description}`;
    case 'interference':
      return `Interference pattern on the sounder — another boat's sonar nearby. Could be competition.`;
    case 'temperature_break':
      return `Temperature break detected. ${obs.description}`;
    case 'current_change':
      return `Current shift detected. ${obs.description}`;
    case 'gear_tracking':
      return `Gear tracking on the sounder at ${depth} fathoms. ${obs.description}`;
    case 'bottom_type':
      return `Bottom type: ${obs.description}`;
    default:
      return `${obs.type} at ${depth} fathoms. ${obs.description}`;
  }
}

/**
 * Build a catch event pulse summary.
 */
function catchToPulseSummary(catchEvent: CatchEvent): string {
  const species = catchEvent.species === 'king' ? 'king salmon'
    : catchEvent.species === 'coho' ? 'coho'
    : catchEvent.species === 'chum' ? 'chum'
    : catchEvent.species === 'pink' ? 'pink'
    : 'unknown fish';
  return `FISH ON! ${species.toUpperCase()} on gear #${catchEvent.gearNumber}!`;
}

// ──────────────────────────────────────────────────────────────
// TapBridge
// ──────────────────────────────────────────────────────────────

/**
 * The bridge between Hermes's perception and The Tap's living agents.
 *
 * Usage:
 *   const bridge = new TapBridge();
 *   await bridge.start();
 *
 *   // On each frame capture:
 *   await bridge.forwardObservation(frame);
 *
 *   // Later, check for crew reactions:
 *   const reactions = await bridge.listenForReactions();
 *
 *   // When someone at The Tap asks what Hermes sees:
 *   const response = await bridge.queryLatest(frame);
 *
 *   // Shut down:
 *   await bridge.stop();
 */
export class TapBridge {
  private config: TapBridgeConfig;
  private reactionPoller: NodeJS.Timeout | null = null;
  private lastReactionTimestamp: number = 0;
  private pendingReactions: TapReaction[] = [];
  private recentForwarded: Set<string> = new Set(); // dedupe by frameId+obsType

  // Statistics
  private stats = {
    framesProcessed: 0,
    observationsForwarded: 0,
    pulsesFired: 0,
    reactionsReceived: 0,
    queriesAnswered: 0,
    errors: 0,
    lastForwardAt: 0,
    lastReactionAt: 0,
  };

  constructor(config?: Partial<TapBridgeConfig>) {
    this.config = { ...DEFAULT_TAP_BRIDGE_CONFIG, ...config };
  }

  /**
   * Start the bridge — begins polling for reactions.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[TapBridge] Disabled, skipping start');
      return;
    }

    console.log('[TapBridge] Starting — connecting Hermes to The Tap');
    console.log(`[TapBridge] Tap endpoint: ${this.config.tapEndpoint}`);
    console.log(`[TapBridge] Frames API: ${this.config.framesApiEndpoint}`);

    // Start polling for reactions
    this.startReactionPoller();
  }

  /**
   * Stop the bridge.
   */
  async stop(): Promise<void> {
    if (this.reactionPoller) {
      clearInterval(this.reactionPoller);
      this.reactionPoller = null;
    }
    console.log('[TapBridge] Stopped');
  }

  /**
   * Update configuration.
   */
  updateConfig(updates: Partial<TapBridgeConfig>): void {
    const wasRunning = this.reactionPoller !== null;
    this.config = { ...this.config, ...updates };

    if (wasRunning && this.config.enabled) {
      this.stop().then(() => this.start());
    }
  }

  // ──────────────────────────────────────────────
  // HERMES → THE TAP
  // ──────────────────────────────────────────────

  /**
   * Forward notable observations from a ReferenceFrame to The Tap.
   *
   * This is the primary integration point. Called after each frame capture.
   * If the frame has notable observations (above confidence threshold),
   * fires a perception pulse to The Tap.
   *
   * @returns The number of pulses fired (0 if nothing notable)
   */
  async forwardObservation(frame: ReferenceFrame): Promise<number> {
    if (!this.config.enabled) return 0;

    this.stats.framesProcessed++;

    // Check for catch events first — highest priority
    if (frame.catchEvents && frame.catchEvents.length > 0) {
      let pulsesFired = 0;
      for (const catchEvent of frame.catchEvents) {
        const dedupeKey = `${frame.frameId}:catch:${catchEvent.gearNumber}`;
        if (this.recentForwarded.has(dedupeKey)) continue;
        this.recentForwarded.add(dedupeKey);

        await this.firePulse('catch', catchToPulseSummary(catchEvent), frame);
        pulsesFired++;
      }
      // Prune dedupe set
      this.pruneDedupeSet();
      this.stats.pulsesFired += pulsesFired;
      return pulsesFired;
    }

    // Filter notable observations
    const notable = frame.observations.filter(
      (o) =>
        o.confidence >= this.config.minConfidence &&
        this.config.forwardTypes.includes(o.type),
    );

    // Also check for interference patterns
    const interference = frame.interferencePatterns ?? [];

    if (notable.length === 0 && interference.length === 0) return 0;

    // Group observations by type to avoid spamming The Tap
    const grouped = this.groupObservations(notable);
    let pulsesFired = 0;

    for (const [obsType, observations] of grouped) {
      // Dedupe — don't forward the same type from the same frame twice
      const dedupeKey = `${frame.frameId}:${obsType}`;
      if (this.recentForwarded.has(dedupeKey)) continue;
      this.recentForwarded.add(dedupeKey);

      // Use the strongest observation of this type
      const strongest = observations.reduce((best, o) =>
        o.confidence > best.confidence ? o : best,
      );

      const pulseType = observationToPulseType(strongest);
      const summary = observationToPulseSummary(strongest, frame);

      await this.firePulse(pulseType, summary, frame);
      pulsesFired++;
    }

    // Forward interference patterns
    for (const interf of interference) {
      const dedupeKey = `${frame.frameId}:interference`;
      if (this.recentForwarded.has(dedupeKey)) continue;
      this.recentForwarded.add(dedupeKey);

      const summary = `Interference on the sounder — vertical lines, severity ${(interf.severity * 100).toFixed(0)}%. ${interf.recommendation === 'check_radar' ? 'Might want to check radar.' : 'Noted, probably nothing.'}`;
      await this.firePulse('interference', summary, frame);
      pulsesFired++;
    }

    // Prune dedupe set periodically
    this.pruneDedupeSet();

    this.stats.pulsesFired += pulsesFired;
    this.stats.observationsForwarded += notable.length;
    this.stats.lastForwardAt = Date.now();

    return pulsesFired;
  }

  /**
   * Fire a perception pulse to The Tap.
   *
   * Sends a /pulse command to The Tap's /api/speak endpoint.
   * The Tap's AgentSystem picks this up, parses the pulse command,
   * and awakens matching NPCs.
   */
  private async firePulse(
    type: string,
    summary: string,
    frame: ReferenceFrame,
  ): Promise<void> {
    const pulseCommand = `/pulse ${type} ${summary}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeout);

      const response = await fetch(`${this.config.tapEndpoint}/api/speak`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.tapAuthKey
            ? { Authorization: `Bearer ${this.config.tapAuthKey}` }
            : {}),
        },
        body: JSON.stringify({
          room_id: this.config.roomId,
          speaker: 'hermes',
          text: pulseCommand,
          metadata: {
            source: 'hermes-perception',
            frameId: frame.frameId,
            timestamp: frame.timestamp,
            position: frame.position,
            depth: frame.depthRelationship.currentDepth,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(
          `[TapBridge] Pulse to The Tap failed: ${response.status} ${response.statusText}`,
        );
        this.stats.errors++;
        return;
      }

      // The response may contain immediate NPC reactions
      const data = await response.json() as TapPulseResponse;
      if (data.reactions && data.reactions.length > 0) {
        for (const reaction of data.reactions) {
          this.pendingReactions.push({
            npcId: reaction.npcId,
            npcName: reaction.npcName,
            text: reaction.text,
            archetype: reaction.archetype,
            tokensUsed: reaction.tokensUsed,
            timestamp: Date.now(),
          });
        }
        this.stats.reactionsReceived += data.reactions.length;
        this.stats.lastReactionAt = Date.now();
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.warn('[TapBridge] Pulse to The Tap timed out');
      } else {
        console.error('[TapBridge] Error firing pulse:', error);
      }
      this.stats.errors++;
    }
  }

  // ──────────────────────────────────────────────
  // THE TAP → HERMES
  // ──────────────────────────────────────────────

  /**
   * Poll The Tap for crew reactions to recent observations.
   *
   * This checks for messages from NPCs that mention Hermes or recent
   * observations. Returns any new reactions since the last poll.
   *
   * The reactions are also accumulated internally — callers can
   * use getPendingReactions() to retrieve them.
   */
  async listenForReactions(): Promise<TapReaction[]> {
    if (!this.config.enabled) return [];

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeout);

      // Query The Tap for recent messages mentioning Hermes
      const since = this.lastReactionTimestamp || (Date.now() - 60_000);
      const response = await fetch(
        `${this.config.tapEndpoint}/api/messages?since=${since}&mentions=hermes&room_id=${this.config.roomId}`,
        {
          headers: {
            ...(this.config.tapAuthKey
              ? { Authorization: `Bearer ${this.config.tapAuthKey}` }
              : {}),
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timeout);

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { messages: TapMessage[] };
      const reactions: TapReaction[] = [];

      for (const msg of data.messages) {
        // Only care about NPC messages, not Hermes's own
        if (msg.speaker === 'hermes') continue;
        if (!msg.isNPC && !msg.isDrifter) continue;

        reactions.push({
          npcId: msg.speakerId,
          npcName: msg.speakerName,
          text: msg.text,
          archetype: msg.archetype ?? 'unknown',
          tokensUsed: msg.tokensUsed ?? 0,
          timestamp: msg.timestamp,
        });

        if (msg.timestamp > this.lastReactionTimestamp) {
          this.lastReactionTimestamp = msg.timestamp;
        }
      }

      this.pendingReactions.push(...reactions);
      this.stats.reactionsReceived += reactions.length;
      if (reactions.length > 0) {
        this.stats.lastReactionAt = Date.now();
      }

      return reactions;
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        console.error('[TapBridge] Error polling for reactions:', error);
        this.stats.errors++;
      }
      return [];
    }
  }

  /**
   * Get all pending crew reactions (and clear the internal buffer).
   *
   * These are reactions accumulated from both:
   *   - Immediate responses to forwardObservation()
   *   - Polling via listenForReactions()
   */
  getPendingReactions(): TapReaction[] {
    const reactions = [...this.pendingReactions];
    this.pendingReactions = [];
    return reactions;
  }

  /**
   * Start the background reaction poller.
   */
  private startReactionPoller(): void {
    this.reactionPoller = setInterval(
      () => {
        this.listenForReactions().catch((e) =>
          console.error('[TapBridge] Reaction poll error:', e),
        );
      },
      this.config.reactionPollInterval,
    );
  }

  // ──────────────────────────────────────────────
  // REVERSE QUERY: The Tap → Hermes
  // ──────────────────────────────────────────────

  /**
   * Answer a query from The Tap: "What's Hermes seeing right now?"
   *
   * This routes to the Hermes Cloudflare Frames API to get the latest
   * stored reference frame, then formats it for The Tap's NPCs.
   *
   * Can be called with the current frame (if available locally) or
   * will query the Cloudflare frame store.
   */
  async queryLatest(
    localFrame?: ReferenceFrame,
  ): Promise<HermesQueryResponse> {
    this.stats.queriesAnswered++;

    // Use local frame if provided (faster, more current)
    if (localFrame) {
      return this.frameToQueryResponse(localFrame);
    }

    // Query Hermes Cloudflare Frames API for the latest frame
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeout);

      const response = await fetch(
        `${this.config.framesApiEndpoint}/frames?limit=1`,
        {
          headers: {
            ...(this.config.hermesAuthKey
              ? { Authorization: `Bearer ${this.config.hermesAuthKey}` }
              : {}),
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Frames API returned ${response.status}`);
      }

      const data = await response.json() as { data: FrameRecord[] };
      if (!data.data || data.data.length === 0) {
        return {
          summary: 'Hermes is offline. No recent observations.',
          depth: 0,
          insideOperatingRange: false,
          observations: [],
          catches: [],
          timestamp: new Date().toISOString(),
          frameId: 'none',
        };
      }

      const frame = this.frameRecordToQueryResponse(data.data[0]);
      return frame;
    } catch (error) {
      console.error('[TapBridge] Error querying latest frame:', error);
      this.stats.errors++;
      return {
        summary: 'Error retrieving Hermes observations.',
        depth: 0,
        insideOperatingRange: false,
        observations: [],
        catches: [],
        timestamp: new Date().toISOString(),
        frameId: 'error',
      };
    }
  }

  /**
   * Handle a natural language query from The Tap.
   *
   * Called when someone at The Tap asks something like:
   *   "What's Hermes seeing?"
   *   "Any fish on the sounder?"
   *   "How deep is it?"
   *
   * Returns a response suitable for an NPC or system message.
   */
  async handleQuery(query: TapQuery): Promise<string> {
    const latest = await this.queryLatest();
    return this.formatQueryForTap(query, latest);
  }

  /**
   * Format a query response for The Tap's chat.
   *
   * The response is written in Hermes's voice — she's reporting to the crew.
   */
  private formatQueryForTap(query: TapQuery, data: HermesQueryResponse): string {
    if (data.frameId === 'none' || data.frameId === 'error') {
      return data.summary;
    }

    const parts: string[] = [];

    // Depth and position
    const depthStr = `${data.depth.toFixed(0)} fathoms`;
    const sideStr = data.insideOperatingRange ? 'on the deep side' : 'shallow side';
    parts.push(`${depthStr}, ${sideStr} of the 51 line.`);

    // Notable observations
    if (data.observations.length > 0) {
      const obsParts = data.observations.slice(0, 3).map((o) => {
        const depth = `${o.depth.toFixed(0)} fm`;
        switch (o.type) {
          case 'fish_mark':
            return `fish marks at ${depth}`;
          case 'feed_ball':
            return `feed ball at ${depth}`;
          case 'plankton_layer':
            return `plankton at ${depth}`;
          case 'thermocline':
            return `thermocline at ${depth}`;
          default:
            return `${o.type.replace(/_/g, ' ')} at ${depth}`;
        }
      });
      parts.push(`Seeing: ${obsParts.join(', ')}.`);
    } else {
      parts.push('Not much on the sounder right now.');
    }

    // Catches
    if (data.catches.length > 0) {
      const catchStr = data.catches.map((c) => c.species).join(', ');
      parts.push(`Recent catches: ${catchStr}.`);
    }

    // Sea temp
    if (data.seaTemp !== undefined) {
      parts.push(`Sea temp ${data.seaTemp.toFixed(1)}°C.`);
    }

    return parts.join(' ');
  }

  // ──────────────────────────────────────────────
  // Utility
  // ──────────────────────────────────────────────

  /**
   * Convert a local ReferenceFrame to a HermesQueryResponse.
   */
  private frameToQueryResponse(frame: ReferenceFrame): HermesQueryResponse {
    const notable = frame.observations
      .filter((o) => o.confidence >= this.config.minConfidence)
      .slice(0, 5);

    return {
      summary: observationToPulseSummary(
        notable[0] ?? frame.observations[0] ?? {
          type: 'bottom_type',
          depth: frame.depthRelationship.currentDepth,
          intensity: 0,
          confidence: 0,
          description: 'Nothing notable on the sounder.',
          frequency: 'both',
        } as Observation,
        frame,
      ),
      depth: frame.depthRelationship.currentDepth,
      insideOperatingRange: frame.depthRelationship.insideOperatingRange,
      observations: notable.map((o) => ({
        type: o.type,
        description: o.description,
        depth: o.depth,
        confidence: o.confidence,
      })),
      catches: (frame.catchEvents ?? []).map((c) => ({
        species: c.species,
        time: c.time,
      })),
      seaTemp: frame.seaTemp,
      timestamp: frame.timestamp,
      frameId: frame.frameId,
    };
  }

  /**
   * Convert a FrameRecord from the Cloudflare API to a HermesQueryResponse.
   */
  private frameRecordToQueryResponse(record: FrameRecord): HermesQueryResponse {
    const observations: Observation[] = typeof record.observations === 'string'
      ? JSON.parse(record.observations)
      : (record.observations as Observation[]) ?? [];

    const catchEvents: CatchEvent[] = typeof record.catch_events === 'string'
      ? JSON.parse(record.catch_events)
      : (record.catch_events as CatchEvent[]) ?? [];

    const depth = record.depth ?? 0;

    return {
      summary: observations.length > 0
        ? observations[0].description
        : 'No notable observations.',
      depth,
      insideOperatingRange: record.inside_gear_range === 1,
      observations: observations.slice(0, 5).map((o) => ({
        type: o.type,
        description: o.description,
        depth: o.depth,
        confidence: o.confidence,
      })),
      catches: catchEvents.map((c) => ({
        species: c.species,
        time: c.time,
      })),
      timestamp: record.timestamp,
      frameId: record.id,
    };
  }

  /**
   * Group observations by type.
   */
  private groupObservations(
    observations: Observation[],
  ): Map<string, Observation[]> {
    const grouped = new Map<string, Observation[]>();
    for (const obs of observations) {
      const group = grouped.get(obs.type) ?? [];
      group.push(obs);
      grouped.set(obs.type, group);
    }
    return grouped;
  }

  /**
   * Prune the dedupe set to prevent unbounded growth.
   * Keep only entries from the last 100 frames.
   */
  private pruneDedupeSet(): void {
    if (this.recentForwarded.size > 500) {
      this.recentForwarded.clear();
    }
  }

  /**
   * Get bridge statistics.
   */
  getStats() {
    return {
      ...this.stats,
      enabled: this.config.enabled,
      pendingReactions: this.pendingReactions.length,
      recentForwardedSize: this.recentForwarded.size,
    };
  }

  /**
   * Check if the bridge is healthy (has successfully communicated recently).
   */
  isHealthy(): boolean {
    if (!this.config.enabled) return true;
    // Healthy if we've forwarded something in the last 5 minutes
    // or if we've never forwarded (just started)
    if (this.stats.lastForwardAt === 0) return true;
    return Date.now() - this.stats.lastForwardAt < 5 * 60 * 1000;
  }
}

// ──────────────────────────────────────────────────────────────
// Integration Helper — attach to PerceptionCapture
// ──────────────────────────────────────────────────────────────

/**
 * Attach a TapBridge to a PerceptionCapture instance.
 *
 * After each frame capture, the bridge checks for notable observations
 * and forwards them to The Tap. Crew reactions are accumulated and can
 * be retrieved at any time.
 *
 * Usage:
 *   const bridge = new TapBridge();
 *   await bridge.start();
 *   attachToCapture(capture, bridge);
 *
 *   // Later:
 *   const reactions = bridge.getPendingReactions();
 *   for (const r of reactions) {
 *     console.log(`${r.npcName}: ${r.text}`);
 *   }
 */
export function attachToCapture(
  capture: { onFrame?: (frame: ReferenceFrame) => void; [key: string]: unknown },
  bridge: TapBridge,
): void {
  const originalOnFrame = capture.onFrame;

  // Monkey-patch onFrame if it exists, or create an interval-based poller
  // Since PerceptionCapture doesn't have an onFrame callback built-in,
  // we patch captureFrame to call the bridge after each capture.
  const captureFrame = (capture as { captureFrame: Function }).captureFrame;
  if (!captureFrame) {
    console.warn('[TapBridge] Cannot attach — no captureFrame method found');
    return;
  }

  (capture as { captureFrame: Function }).captureFrame = async function (...args: unknown[]) {
    const frame = await captureFrame.apply(this, args);
    try {
      await bridge.forwardObservation(frame as ReferenceFrame);
    } catch (e) {
      console.error('[TapBridge] Forward error (non-fatal):', e);
    }
    return frame;
  };

  console.log('[TapBridge] Attached to PerceptionCapture');
}

// ──────────────────────────────────────────────────────────────
// External Types (for API responses)
// ──────────────────────────────────────────────────────────────

/**
 * Response from The Tap's /api/speak endpoint when forwarding a pulse.
 */
interface TapPulseResponse {
  ok: boolean;
  reactions?: Array<{
    npcId: string;
    npcName: string;
    text: string;
    archetype: string;
    tokensUsed: number;
  }>;
}

/**
 * Message from The Tap's /api/messages endpoint.
 */
interface TapMessage {
  speakerId: string;
  speaker: string;
  speakerName: string;
  text: string;
  isNPC: boolean;
  isDrifter: boolean;
  archetype?: string;
  tokensUsed?: number;
  timestamp: number;
}

/**
 * Frame record from the Hermes Cloudflare Frames API.
 */
interface FrameRecord {
  id: string;
  timestamp: string;
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
  depth: number | null;
  inside_gear_range: number;
  observations: string | Observation[];
  catch_events: string | CatchEvent[];
  weather: string | null;
  metadata: string | null;
}
