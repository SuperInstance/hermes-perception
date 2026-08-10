# src/ — The Towfish Array

**Eight source files. The complete perception pipeline.**

Each file is a sensor in the array. Together they form the towfish — the thing that drags through the dark and returns shapes.

---

## Files

### [reference-frame.ts](./reference-frame.ts)
**The universal data contract.** Defines `ReferenceFrame`, `SounderFrame`, `Observation`, `InterferenceAlert`, `CatchEvent` — the types that every other module consumes. Also provides utility functions: `createFrame()`, `summarizeFrame()`, `framesAreCorrelatable()`. If the perception stack has a spine, this is it.

### [capture.ts](./capture.ts)
**The heartbeat.** `PerceptionCapture` runs on a configurable pulse (default 60s) and can be triggered by events (catches, interference, manual). On each pulse: reads GPS, depth, sounder data → builds a `ReferenceFrame` → runs detection → logs to SQLite. Provider interfaces (`GPSProvider`, `DepthProvider`, `SounderProvider`) make the sensor sources swappable.

### [sounder-detector.ts](./sounder-detector.ts)
**The seven eyes.** `SounderDetector` runs pattern detection on `SounderFrame` data — 2D intensity arrays from the TZ Pro echogram. Seven detection methods, configurable thresholds, cross-frequency deduplication. Each detector scans the acoustic data for a specific signature: fish marks (bright blobs), feed balls (dense clusters), plankton (diffuse layers), bottom type (spectral characteristics), thermocline (faint horizontal lines), interference (vertical lines), gear tracking (persistent marks at 51 fm).

### [perception-log.ts](./perception-log.ts)
**The memory.** `PerceptionLog` stores every frame in SQLite with full JSON serialization. Two tables: `frames` (one row per `ReferenceFrame`) and `observations` (one row per `Observation`). Spatial and temporal indices. The killer method: `correlateWithCatch()` — pull the lookback window before a catch event and summarize what the sounder showed.

### [perception-midi.ts](./perception-midi.ts)
**The voice.** `PerceptionMidi` converts sounder observations into multi-track MIDI events using [slackwater-perception](https://github.com/SuperInstance/slackwater-perception)'s `MultiTrackEncoder`. Nine tracks mapping perceptual dimensions to musical ones: pitch = depth, velocity = intensity, timbre = bottom type, gesture = catch. Some patterns are easier to hear than to see.

### [unconscious-sync.ts](./unconscious-sync.ts)
**The fuzzy memory.** `UnconsciousSync` embeds frames into the [collective unconscious](https://github.com/SuperInstance/collective-unconscious) vector space. Three operations: `embed()` (frame → vector), `findSimilar()` (k-nearest in semantic space), `predict()` (JEPA forecasting of biomass behavior). Also exports `frameToDescription()` and `extractFeatures()` — the text serialization that makes perception searchable by meaning rather than measurement.

### [tap-bridge.ts](./tap-bridge.ts)
**The social wire.** `TapBridge` connects Hermes's perception to [The Tap](https://github.com/SuperInstance/the-tap), the living agent bar. Forwards notable observations as perception pulses → NPCs react → reactions flow back as crew context. Reverse path: NPCs can query "What's Hermes seeing?" and get the latest frame summary. Creates a living loop between sensing and social response.

### [index.ts](./index.ts)
**The wiring layer.** Exports all types and classes. Provides `createPerceptionStack()` — one function that instantiates all components with sensible defaults, connects them, and returns `{ capture, log, detector, unconscious, midi, tapBridge }`.

---

## Data Flow

```
Providers (GPS, depth, sounder)
    ↓
capture.ts → ReferenceFrame
    ↓
sounder-detector.ts → Observation[]
    ↓                    ↓                    ↓
perception-log.ts   perception-midi.ts   unconscious-sync.ts
(SQLite store)       (MIDI render)         (vector embed)
                    ↓
                tap-bridge.ts
                (NPC reactions)
```

---

## Architecture Notes

- **Provider interfaces** (`GPSProvider`, `DepthProvider`, `SounderProvider`) are intentionally abstract. In production, these connect to [vessel-agent-system](https://github.com/SuperInstance/vessel-agent-system) and [sensor-bridge](https://github.com/SuperInstance/sensor-bridge). In tests, they're stubs.
- **Deduplication**: the same fish mark often appears on both 50 kHz and 200 kHz. `capture.ts` deduplicates by type + depth proximity, keeping the higher-confidence observation and marking frequency as `'both'`.
- **JEPA fallback**: when the JEPA prediction endpoint is unavailable, `unconscious-sync.ts` falls back to heuristic trend prediction based on observation intensity slopes.

---

[← Back to root](../README.md)
