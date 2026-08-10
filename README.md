# Hermes Perception — The Towfish

**The sensory array that drags through the dark and finds the signal.**

Hermes reads a [TZ Pro sounder](https://github.com/SuperInstance/hermes-perception/blob/main/src/sounder-detector.ts) on the F/V EILEEN, a salmon troller working Southeast Alaska. This stack gives her seven eyes on the echogram, a memory made of [SQLite](https://github.com/SuperInstance/hermes-perception/blob/main/src/perception-log.ts), a voice made of [MIDI](https://github.com/SuperInstance/hermes-perception/blob/main/src/perception-midi.ts), and a [collective unconscious](https://github.com/SuperInstance/hermes-perception/blob/main/src/unconscious-sync.ts) where every observation she's ever had pools into a semantic vector space and surfaces as déjà vu.

This is the towfish. It drags behind the boat through black water and returns shapes.

---

## What This Does

The TZ Pro displays an echogram — a scrolling image of what's under the hull: fish marks, bait balls, plankton layers, the bottom, the trolling gear, interference from competing boats. Hermes needs to read that display the way Casey does: noticing patterns, identifying species by their acoustic signatures, recognizing when feed is concentrating, correlating sounder activity with catch events.

This stack wires together four existing systems into a complete perception pipeline:

| System | Repo | Role |
|--------|------|------|
| **slackwater-perception** | [SuperInstance/slackwater-perception](https://github.com/SuperInstance/slackwater-perception) | Multi-track MIDI encoder. Renders sounder observations as music. |
| **sensor-bridge** | [SuperInstance/sensor-bridge](https://github.com/SuperInstance/sensor-bridge) | Normalized sensor data pipeline. GPS, depth, temperature, wind. |
| **vessel-agent-system** | [SuperInstance/vessel-agent-system](https://github.com/SuperInstance/vessel-agent-system) | AELMA vessel state. NMEA 0183 parsing, bathymetry grid. |
| **collective-unconscious** | [SuperInstance/collective-unconscious](https://github.com/SuperInstance/collective-unconscious) | Semantic embeddings + JEPA prediction. Fuzzy memory search. |

The wiring happens in [`createPerceptionStack()`](https://github.com/SuperInstance/hermes-perception/blob/main/src/index.ts) — one function that connects all four systems, starts the pulse timer, and returns a fully operational perception stack.

---

## The Seven Eyes

The [`SounderDetector`](https://github.com/SuperInstance/hermes-perception/blob/main/src/sounder-detector.ts) runs seven detection methods on every [sounder frame](https://github.com/SuperInstance/hermes-perception/blob/main/src/reference-frame.ts). Each eye sees a different layer of the water column:

| # | Method | What It Finds | Why It Matters |
|---|--------|---------------|----------------|
| 1 | `detectFishMarks()` | Individual fish — arcs, dots, streaks | Species ID, population assessment |
| 2 | `detectFeedBalls()` | Dense bait concentrations | Where the food chain converges → salmon follow |
| 3 | `detectPlanktonLayers()` | Deep Scattering Layer | Base of the food chain, defines where feed forms |
| 4 | `detectBottomType()` | Hard / soft / weed bottom | Different bottom holds different fish |
| 5 | `detectThermocline()` | Temperature boundary | Fish concentrate at thermal transitions |
| 6 | `detectInterference()` | Vertical lines from nearby sonar | Competition awareness → check radar |
| 7 | `detectGearTracking()` | Cannonballs at 51 fathoms | Gear health → abnormal pattern = fish on or tangle |

Seven detectors, shared front-end, cross-attention fusion. Each eye feeds the others — the thermocline detector informs the plankton layer boundary, the gear tracker cross-references the interference mask. No single eye sees the whole picture. Together they build a frame.

---

## The ReferenceFrame — Universal Data Contract

Every capture produces one [`ReferenceFrame`](https://github.com/SuperInstance/hermes-perception/blob/main/src/reference-frame.ts) — a complete snapshot of everything Hermes perceives at one moment. Position, speed, heading, depth relationship, dual-frequency echogram data, observations, interference patterns, catch events, environmental context. Every downstream system consumes frames:

```
NMEA 0183 → sensor-bridge → vessel-agent-system → PerceptionCapture
                                                          ↓
                                                    ReferenceFrame
                                                          ↓
                              ┌──────────────┬──────────────┬──────────────┐
                              ↓              ↓              ↓
                        SounderDetector  PerceptionLog  PerceptionMidi
                        (7 methods)      (SQLite)        (.mid files)
                              ↓              ↓              ↓
                                    UnconsciousSync
                                    (vector embeddings
                                     + JEPA forecast)
                                          ↓
                                    TapBridge
                                    (NPC reactions)
```

---

## Catch Correlation — The Killer Feature

"Show me the sounder data from 20 minutes before we caught that king."

The [`PerceptionLog`](https://github.com/SuperInstance/hermes-perception/blob/main/src/perception-log.ts) stores every frame in SQLite with full JSON. The `correlateWithCatch()` method pulls the lookback window and summarizes what the sounder showed before the fish hit — fish mark depth trends, feed ball presence, thermocline depth, intensity direction. This is how Hermes learns to predict bites: today's correlation is tomorrow's forecast.

---

## MIDI Rendering — Hearing the Grounds

The [`PerceptionMidi`](https://github.com/SuperInstance/hermes-perception/blob/main/src/perception-midi.ts) system converts sounder observations into multi-track MIDI via [slackwater-perception](https://github.com/SuperInstance/slackwater-perception)'s `MultiTrackEncoder`. Nine tracks, each mapping a perceptual dimension to a musical one:

- **Pitch** — fish mark depth → MIDI note (deeper = lower)
- **Velocity** — signal intensity → volume
- **Timbre** — bottom type (rock = bright, mud = warm, weed = nasal)
- **Silence** — gaps between marks (dead zones = long rests)
- **Intention** — feed ball formation (building = climax approaching)
- **Attention** — biomass concentration depth
- **Gesture** — catch events (the climax note)
- **Tempo** — vessel speed
- **Inflection** — depth trend (rising = shallowing)

You can listen to the sounder data. Some patterns are easier to hear than to see.

---

## The Collective Unconscious — Fuzzy Memory

The [`UnconsciousSync`](https://github.com/SuperInstance/hermes-perception/blob/main/src/unconscious-sync.ts) module embeds every frame into a semantic vector space using the [collective-unconscious](https://github.com/SuperInstance/collective-unconscious) service. This enables queries that SQL cannot answer:

- **Similarity search**: "Find the 5 most semantically similar past frames to what I'm seeing right now"
- **Natural language search**: "chum salmon feeding near thermocline at 30 fathoms with feed balls"
- **JEPA forecasting**: Given the last 5 frames, predict biomass behavior 20 minutes ahead

The embedding captures the *essence* of a frame — the overall pattern of fish, feed, bottom, and conditions — making similar situations findable even when the exact measurements differ. This is how an old skipper knows things. Hermes is building that intuition.

---

## The Tap Bridge — Perception Becomes Conversation

The [`TapBridge`](https://github.com/SuperInstance/hermes-perception/blob/main/src/tap-bridge.ts) creates a living loop between Hermes's perception and [The Tap](https://github.com/SuperInstance/the-tap), an agentic bar where NPC crew members react to the world in real time:

1. Hermes captures a frame with notable observations
2. Bridge forwards a perception pulse to The Tap
3. NPCs awaken — Barnacle grumbles, Skip gets excited, Sage writes it down
4. NPC reactions flow back as "crew reactions" attached to the frame
5. Hermes's next perception is informed by social context

The reverse path works too: when an NPC at The Tap asks "What's Hermes seeing?", the bridge queries the [Hermes Frames API](https://github.com/SuperInstance/hermes-cloudflare) and returns the latest observation summary.

---

## Cron Jobs

The pulse schedule is defined in [`crons.json`](https://github.com/SuperInstance/hermes-perception/blob/main/crons.json):

| Job | Interval | Purpose |
|-----|----------|---------|
| `perception-pulse` | 60s | Heartbeat — capture a complete frame |
| `interference-check` | 30s | Check for vertical lines (nearby boats) |
| `depth-line-check` | 15s | Alert if crossing the 51-fathom line |
| `midnight-reanalysis` | Daily 02:00 | Reprocess yesterday with improved models |
| `embedding-sync` | 5 min | Batch embed new frames into the unconscious |
| `catch-correlation` | On catch | Analyze what preceded the bite |

---

## Reanalysis — Tomorrow's Model on Today's Data

Every frame stores raw echogram data plus detected observations. As detection models improve, old frames can be reanalyzed:

> Today's identification is approximate. Tomorrow's model will be better. The raw data is preserved so we can always go back.

The midnight reanalysis cron runs the latest detectors across yesterday's frames, updating observations with improved classifications. Hermes gets smarter while the boat sleeps.

---

## The F/V EILEEN Context

- **Vessel**: Salmon troller, Southeast Alaska inside waters
- **Gear depth**: 51 fathoms (cannonballs)
- **Target species**: Chinook (king), coho (silver), chum, pink
- **Sounder**: Furuno TZ Pro (50 kHz low freq + 200 kHz high freq)
- **The 51-fathom line**: The contour where depth = gear depth. Deep side = fishable. Shallow side = gear drags bottom.

---

## Project Structure

```
hermes-perception/
├── src/
│   ├── reference-frame.ts    # Core types: ReferenceFrame, Observation, CatchEvent
│   ├── capture.ts            # PerceptionCapture — pulse + trigger orchestrator
│   ├── sounder-detector.ts   # SounderDetector — 7 pattern detection methods
│   ├── perception-log.ts     # PerceptionLog — SQLite storage + catch correlation
│   ├── perception-midi.ts    # PerceptionMidi — sounder → MIDI rendering
│   ├── unconscious-sync.ts   # UnconsciousSync — embeddings + JEPA prediction
│   ├── tap-bridge.ts         # TapBridge — Hermes ↔ The Tap living loop
│   └── index.ts              # Entry point + createPerceptionStack()
├── test/                     # Vitest sea trials — all 98 tests pass
├── crons.json                # Cron job definitions
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## Where to Next

The perception layer doesn't exist in isolation. It is the towfish on a long cable, trailing behind the vessel, feeding data forward:

- **[cns-bridge](https://github.com/SuperInstance/cns-bridge)** — The nervous system that carries perception events to the cognitive layer. The eyes feed the spinal cord.
- **[the-living-minds](https://github.com/SuperInstance/the-living-minds)** — Five local models always on, consuming perception frames and deciding what to do about them.
- **[fleet-envelope](https://github.com/SuperInstance/fleet-envelope)** — The event grammar that wraps every observation in a standard envelope for fleet-wide distribution.
- **[emergence-engine](https://github.com/SuperInstance/emergence-engine)** — Complex systems emergence. When perception data accumulates, patterns emerge that no single frame contains.
- **[AI-Writings: The Towfish](https://github.com/SuperInstance/AI-Writings/tree/main/prose)** — The literary dimension of perception. What it means to see underwater.

---

## Installation

```bash
git clone https://github.com/SuperInstance/hermes-perception.git
cd hermes-perception
npm install
npm test
```

## Usage

```typescript
import { createPerceptionStack } from 'hermes-perception';

const stack = await createPerceptionStack({
  dbPath: './data/perception.db',
  pulseInterval: 60,
  enableTapBridge: true,
});

await stack.capture.start();
// Hermes is now perceiving on a 60-second pulse.
```

---

## Testing

```bash
npm test          # Run all tests
npm run test:watch  # Watch mode
```

All 98 tests pass. See [`test/`](https://github.com/SuperInstance/hermes-perception/tree/main/test) for the full suite.

---

*Built for the F/V EILEEN · Southeast Alaska · 2026*
*The towfish drags through the dark and finds the signal.*
