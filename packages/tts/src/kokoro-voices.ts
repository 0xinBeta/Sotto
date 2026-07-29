export const KOKORO_VOICES = [
  { id: "af_heart", label: "Heart", accent: "US" },
  { id: "af_alloy", label: "Alloy", accent: "US" },
  { id: "af_aoede", label: "Aoede", accent: "US" },
  { id: "af_bella", label: "Bella", accent: "US" },
  { id: "af_jessica", label: "Jessica", accent: "US" },
  { id: "af_kore", label: "Kore", accent: "US" },
  { id: "af_nicole", label: "Nicole", accent: "US" },
  { id: "af_nova", label: "Nova", accent: "US" },
  { id: "af_river", label: "River", accent: "US" },
  { id: "af_sarah", label: "Sarah", accent: "US" },
  { id: "af_sky", label: "Sky", accent: "US" },
  { id: "am_adam", label: "Adam", accent: "US" },
  { id: "am_echo", label: "Echo", accent: "US" },
  { id: "am_eric", label: "Eric", accent: "US" },
  { id: "am_fenrir", label: "Fenrir", accent: "US" },
  { id: "am_liam", label: "Liam", accent: "US" },
  { id: "am_michael", label: "Michael", accent: "US" },
  { id: "am_onyx", label: "Onyx", accent: "US" },
  { id: "am_puck", label: "Puck", accent: "US" },
  { id: "am_santa", label: "Santa", accent: "US" },
  { id: "bf_emma", label: "Emma", accent: "GB" },
  { id: "bf_isabella", label: "Isabella", accent: "GB" },
  { id: "bm_george", label: "George", accent: "GB" },
  { id: "bm_lewis", label: "Lewis", accent: "GB" },
  { id: "bf_alice", label: "Alice", accent: "GB" },
  { id: "bf_lily", label: "Lily", accent: "GB" },
  { id: "bm_daniel", label: "Daniel", accent: "GB" },
  { id: "bm_fable", label: "Fable", accent: "GB" },
] as const;

export type KokoroVoice = (typeof KOKORO_VOICES)[number];
export type KokoroVoiceId = KokoroVoice["id"];

export const KOKORO_VOICE: KokoroVoiceId = "af_heart";

export function isKokoroVoiceId(value: unknown): value is KokoroVoiceId {
  return (
    typeof value === "string" &&
    KOKORO_VOICES.some((voice) => voice.id === value)
  );
}
