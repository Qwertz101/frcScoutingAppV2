/**
 * Bundle entry for the golden-log harness.
 *
 * This exists to pin the OCR chain's behaviour across the DOM-free refactor.
 * It deliberately reaches for the same entry points the app uses — `getOcr`,
 * `readFrame`, `ScoreGate` — rather than reimplementing any of the
 * orchestration, because the orchestration is exactly what is being changed
 * underneath and a reimplementation would not notice if it broke.
 */
import {
  DEFAULT_BLUE_QUAD,
  DEFAULT_RED_QUAD,
  DEFAULT_TIMER_QUAD,
  Quad,
  detectScoreRegions,
  detectScoreRegionsStable,
} from '../../src/services/cv/imagePipeline';
import { ScoreGate, getOcr, readFrame } from '../../src/services/cv/scoreboardOcr';

(window as any).__cv = {
  DEFAULT_BLUE_QUAD,
  DEFAULT_RED_QUAD,
  DEFAULT_TIMER_QUAD,
  detectScoreRegions,
  detectScoreRegionsStable,
  ScoreGate,
  getOcr,
  readFrame,

  /**
   * Read one frame through the real pipeline and return everything a
   * regression diff should care about — every number, no images.
   */
  async readOne(
    worker: any,
    frame: any,
    blue: Quad,
    red: Quad,
    timer: Quad | null,
    blueGate: any,
    redGate: any
  ) {
    const r = await readFrame(worker, frame, blue, red, timer, blueGate, redGate);
    if (!r) return null;
    return {
      blue: r.blue,
      red: r.red,
      blueAccepted: r.blueAccepted,
      redAccepted: r.redAccepted,
      blueRaw: { value: r.blueRaw.value, confidence: r.blueRaw.confidence, text: r.blueRaw.text },
      redRaw: { value: r.redRaw.value, confidence: r.redRaw.confidence, text: r.redRaw.text },
      timer: {
        remaining: r.timer.remaining,
        text: r.timer.text,
        confidence: r.timer.confidence,
      },
      overlayPresent: r.overlayPresent,
    };
  },
};
