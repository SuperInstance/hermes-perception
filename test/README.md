# test/ — Sea Trials

**Five test files. Ninety-eight tests. All passing.**

These are the sea trials. Before the towfish goes in the water, every sensor gets bench-tested here.

---

## Files

### [reference-frame.test.ts](./reference-frame.test.ts)
Tests the core data contract: `createFrame()` defaults (51-fathom gear depth, `insideOperatingRange` logic), `summarizeFrame()` output format, `framesAreCorrelatable()` time/distance thresholds. The foundation — if frames are wrong, everything downstream is wrong.

### [sounder-detector.test.ts](./sounder-detector.test.ts)
Tests the seven detection methods against synthetic echogram data. Empty grids (no detection), bright blobs (fish marks), dense clusters (feed balls), uniform low-intensity layers (plankton). Also tests `DEFAULT_DETECTOR_CONFIG` sanity — gear depth must be 51, thresholds must be in valid ranges.

### [perception-log.test.ts](./perception-log.test.ts)
Tests SQLite storage: frame insertion, query by time range / position / observation type, `correlateWithCatch()` lookback analysis, `exportFrames()` for reanalysis pipelines. Uses in-memory SQLite (`:memory:`) for test isolation.

### [perception-midi.test.ts](./perception-midi.test.ts)
Tests the MIDI rendering pipeline: `depthToMidiNote()` mapping (deeper = lower), `intensityToVelocity()` curve, `observationToTimbre()` color mapping, `frameToMidiEvents()` event generation, `describeRendering()` summary output.

### [unconscious-sync.test.ts](./unconscious-sync.test.ts)
Tests the embedding pipeline: `frameToDescription()` text serialization, `extractFeatures()` structured feature extraction, `findSimilar()` semantic search, `predict()` JEPA forecasting with fallback heuristics. Uses mock embedding endpoints.

---

## Running Tests

```bash
npm test              # Run all 98 tests
npm run test:watch    # Watch mode for development
```

---

[← Back to root](../README.md)
