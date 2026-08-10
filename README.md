# Hermes Perception Stack

**The TZ Pro sounder reading system for the F/V EILEEN.**

Hermes is learning to read the TZ Pro sounder display. This stack wires together four existing repos into a complete perception pipeline: capture → detect → log → embed → predict → render.

---

## What This Does

The F/V EILEEN trolls for salmon on the Alaska coast. The TZ Pro is the boat's fishfinder/sounder — it displays an echogram showing what's under the boat: fish, bait balls, plankton layers, the bottom, and the trolling gear.

Hermes needs to "read" this display the way Casey does: noticing fish marks, identifying species by their echogram signatures, recognizing when feed is concentrating, detecting interference from nearby boats, and correlating sounder patterns with catch events.

This stack gives Hermes that ability.

### The Four Systems It Wires Together

| System | Repo | Role |
|--------|------|------|
| **slackwater-perception** | `slackwater-perception` | Multi-track MIDI encoder. Renders sounder observations as music — a different sensory modality for understanding the grounds. |
| **sensor-bridge** | `sensor-bridge` | Normalized sensor data pipeline. Provides the GPS, depth, temperature, and wind data that frames every observation. |
| **vessel-agent-system** | `vessel-agent-system` | AELMA vessel state. Parses NMEA 0183 sentences for position, heading, speed, and maintains the bathymetry grid. |
| **collective-unconscious** | (via `unconscious-sync.ts`) | Semantic embeddings + JEPA prediction. Enables "fuzzy" search of historical fishing data and forecasting of biomass behavior. |

---

## How Reference Frames Work

A **ReferenceFrame** is the universal data contract — a snapshot of everything Hermes perceives at one moment in time.

```
ReferenceFrame
├── timestamp, frameId, position (lat/lon)
├── speedAndHeading (SOG, COG)
├── depthRelationship
│   ├── currentDepth (fathoms)
│   ├── gearDepth (always 51 — trolling gear)
│   ├── insideOperatingRange (deep side of 51-fathom line?)
│   └── nearestShallow (distance to 51-fathom line)
├── sounderLowFreq (50 kHz echogram — biomass view)
├── sounderHighFreq (200 kHz echogram — target view)
├── observations[] (what Hermes noticed)
│   ├── fish_mark, feed_ball, plankton_layer
│   ├── bottom_type, thermocline, gear_tracking
│   └── interference, temperature_break, current_change
├── interferencePatterns[] (vertical lines = nearby boat)
├── catchEvents[] (fish on the gear)
├── seaTemp, wind (environmental context)
└── source (pulse, triggered, catch, interference, manual)
```

Every frame is:
1. **Captured** on a pulse (default every 60 seconds) or triggered by an event
2. **Detected** — pattern detection runs on the sounder frames to produce observations
3. **Logged** — stored in SQLite with full JSON for reanalysis
4. **Embedded** — converted to a vector in semantic space for similarity search
5. **Optionally rendered** as MIDI for audio-domain pattern recognition

---

## Architecture

```
                    NMEA 0183 (GPS, depth, wind, temp)
                              │
                    ┌─────────▼──────────┐
                    │  sensor-bridge     │
                    │  (normalizer)      │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │  vessel-agent      │
                    │  (VesselState,     │
                    │   BathymetryGrid)  │
                    └─────────┬──────────┘
                              │
     TZ Pro display           │
     (echogram)               │
         │                    │
         ▼                    ▼
    ┌─────────────────────────────────┐
    │     PerceptionCapture           │
    │  (pulse + trigger → frames)     │
    └────────────┬────────────────────┘
                 │
         ┌───────▼────────┐
         │ SounderDetector│
         │ (7 detectors)  │
         └───────┬────────┘
                 │
     ┌───────────┼───────────────┐
     ▼           ▼               ▼
┌─────────┐ ┌─────────┐  ┌──────────────┐
│Perception│ │Perception│  │UnconsciousSync│
│Log      │ │MIDI     │  │(embeddings)  │
│(SQLite) │ │(.mid)   │  │(vectors)     │
└─────────┘ └─────────┘  └──────────────┘
     │                        │
     ▼                        ▼
  Query/correlate         JEPA predict
  ("What did the          ("Biomass likely
   sounder show before     to concentrate
   that catch?")           in 20 min")
```

---

## Sounder Detection: The Seven Eyes

The `SounderDetector` runs seven detection methods on every frame:

| # | Method | What It Finds | Why It Matters |
|---|--------|---------------|----------------|
| 1 | `detectFishMarks()` | Individual fish (arcs, dots, streaks) | Species identification, population assessment |
| 2 | `detectFeedBalls()` | Dense bait concentrations | Where the food chain converges → salmon follow |
| 3 | `detectPlanktonLayers()` | Deep Scattering Layer | Base of the food chain, defines where feed balls form |
| 4 | `detectBottomType()` | Hard/soft/weed bottom | Different bottom types hold different fish |
| 5 | `detectThermocline()` | Temperature boundary | Fish concentrate at thermocline transitions |
| 6 | `detectInterference()` | Vertical lines (nearby boat) | Competition awareness → check radar |
| 7 | `detectGearTracking()` | Trolling cannonballs at 51 fm | Gear health → abnormal pattern = fish on or tangle |

---

## How to Query Historical Data

The `PerceptionLog` stores every frame in SQLite. Query by time, position, depth, or observation type:

```typescript
const log = new PerceptionLog('./data/perception.db');
await log.init();

// All frames from this morning
const morning = await log.query({
  startTime: '2026-08-09T06:00:00Z',
  endTime: '2026-08-09T12:00:00Z',
  sort: 'time_asc',
});

// All feed balls within 500m of a position
const nearby = await log.query({
  nearLat: 58.3,
  nearLon: -134.5,
  radiusM: 500,
  observationType: 'feed_ball',
});

// All catches today
const catches = await log.query({
  observationType: 'fish_mark',
  minConfidence: 0.8,
  sort: 'time_desc',
});
```

### Catch Correlation

The killer feature: "Show me the sounder data from 20 minutes before we caught that king."

```typescript
const correlation = await log.correlateWithCatch('2026-08-09T09:15:00Z', 20);

console.log(correlation.summary);
// "8 fish marks averaging 35 fm, 2 feed balls detected,
//  plankton layer present, thermocline at 28 fm,
//  intensity trend: increasing"

console.log(correlation.patterns);
// { fishMarkDepth: 35, feedBallPresent: true,
//   thermoclineDepth: 28, trendDirection: 'increasing' }
```

---

## How Reanalysis Works

**Old frames + new models = better understanding.**

Every frame stores the raw echogram data (`SounderFrame.data`) plus the observations that were detected at the time. As detection models improve, we can reanalyze old frames:

```typescript
// Export all frames from yesterday
const oldFrames = await log.exportFrames(
  '2026-08-08T00:00:00Z',
  '2026-08-08T23:59:59Z',
);

// Run new detector on old data
const improvedDetector = new SounderDetector({ fishMarkMinContrast: 0.10 });
for (const frame of oldFrames) {
  if (frame.sounderHighFreq) {
    const newObs = improvedDetector.detectAll(frame.sounderHighFreq);
    // Update observations, log new findings
  }
}
```

Today's identification is approximate. Tomorrow's model will be better. The raw data is preserved so we can always go back.

---

## How the MIDI Rendering Works

The `PerceptionMidi` system converts sounder observations into multi-track MIDI, using slackwater-perception's `MultiTrackEncoder`.

Each track represents one perceptual dimension:

| Track | Source | What You Hear |
|-------|--------|---------------|
| **Pitch** | Fish mark depth → MIDI note | Deeper fish = lower notes |
| **Velocity** | Signal intensity → volume | Brighter marks = louder |
| **Timbre** | Bottom type / observation type | Rock = bright, mud = warm, plankton = breathy |
| **Silence** | Gaps between marks | Dead zones = long rests |
| **Intention** | Feed ball formation | Building = climax approaching |
| **Attention** | Biomass concentration depth | Where the focus is |
| **Gesture** | Catch events | The climax note |
| **Tempo** | Vessel speed | Faster trolling = faster tempo |
| **Inflection** | Depth trend | Shallowing = rising, deepening = falling |

```typescript
const midi = new PerceptionMidi();
await midi.renderToFile(frames, './output/fishing-ground.mid');
console.log(midi.describeRendering(frames));
// "60 frames, 127 notes (range: 45-84), 15 silence periods,
//  8 intention signals, 3 CATCH moments"
```

You can LISTEN to the sounder data and hear when fish are active vs scattered, when feed balls form vs dissolve, when the thermocline shifts. It's a different kind of perception — not a replacement for the visual display, but a complement.

---

## How the Collective Unconscious Integration Works

Every frame gets embedded into a semantic vector space. This enables queries that traditional databases can't do:

```typescript
const sync = new UnconsciousSync();
await sync.init();

// Embed a frame
await sync.embed(frame);

// Find similar sounder conditions
const similar = await sync.findSimilar(currentFrame, 5);
// Returns the 5 most semantically similar past frames

// Natural language search
const results = await sync.search(
  "chum salmon feeding near thermocline at 30 fathoms with feed balls",
);

// JEPA prediction: what happens next?
const prediction = await sync.predict(lastFiveFrames, 20);
console.log(prediction.prediction);
// "Biomass increasing, activity rising. Feed may concentrate
//  in the next 20 minutes. Watch for catch opportunities."
console.log(prediction.confidence);
// 0.65
```

The embedding captures the "essence" of a frame — the overall pattern of fish, feed, bottom, and conditions — in a way that makes similar situations findable even when the exact details differ.

### JEPA Forecasting

The Joint Embedding Predictive Architecture (from log-tensor) can forecast future frames based on recent history. This is how Hermes learns to predict:

- "Feed balls are forming → bite likely in 15-20 minutes"
- "Biomass is scattering → move to a different spot"
- "Gear pattern abnormal → check for fish on"

---

## Cron Jobs

See `crons.json` for the full schedule. Key jobs:

| Job | Interval | What It Does |
|-----|----------|--------------|
| `perception-pulse` | 60s | Heartbeat — capture a frame |
| `interference-check` | 30s | Check for nearby boats |
| `depth-line-check` | 15s | Alert if crossing shallow |
| `midnight-reanalysis` | Daily 02:00 | Reprocess yesterday's data with better models |
| `embedding-sync` | 5 min | Batch embed new frames |
| `catch-correlation` | On catch | Analyze what preceded the bite |

---

## Project Structure

```
hermes-perception/
├── src/
│   ├── reference-frame.ts    # Core types: ReferenceFrame, Observation, etc.
│   ├── capture.ts            # PerceptionCapture — pulse + trigger captures
│   ├── sounder-detector.ts   # SounderDetector — 7 pattern detection methods
│   ├── perception-log.ts     # PerceptionLog — SQLite storage + catch correlation
│   ├── perception-midi.ts    # PerceptionMidi — sounder → MIDI rendering
│   ├── unconscious-sync.ts   # UnconsciousSync — embeddings + JEPA prediction
│   └── index.ts              # Entry point — exports + createPerceptionStack()
├── crons.json                # Cron job definitions
├── package.json
├── tsconfig.json
└── README.md
```

---

## The F/V EILEEN Context

The F/V EILEEN is a salmon troller operating in Southeast Alaska. Key operational parameters:

- **Gear depth**: 51 fathoms (cannonballs)
- **Target species**: Chinook (king), coho (silver), chum, pink
- **Sounder**: Furuno TZ Pro (50 kHz low freq + 200 kHz high freq)
- **Operating area**: Primarily inside waters, 40-80 fathoms
- **The 51-fathom line**: The contour where depth = 51 fathoms. Fishing on the deep side of this line = the gear works. Crossing onto the shallow side = gear drags bottom.

---

## This Is the Foundation

This stack is designed to grow. As Hermes matures, we add:

- **Better species identification**: ML models trained on labeled catch data
- **Real-time bite prediction**: JEPA forecasts from live sounder data
- **Ground mapping**: Bathymetric accumulation from depth soundings
- **Fleet communication**: Share observations with other AELMA vessels
- **Historical pattern matching**: "This time last year, the fish were here"

Hermes is reading the TZ Pro right now. Give her the tools.

---

*Built for the F/V EILEEN · Southeast Alaska · 2026*
