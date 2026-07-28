const MIC_LEVEL_ATTACK = 0.65;
const MIC_LEVEL_DECAY = 0.12;

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(1, level));
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) return 0;
    sum += sample * sample;
  }
  return clampLevel(Math.sqrt(sum / samples.length));
}

export function smoothMicLevel(previous: number, rms: number): number {
  const current = clampLevel(previous);
  const target = clampLevel(rms);
  const coefficient =
    target > current ? MIC_LEVEL_ATTACK : MIC_LEVEL_DECAY;
  return clampLevel(current + (target - current) * coefficient);
}
