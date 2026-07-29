import { describe, expect, it, vi } from "vitest";

import {
  controlMediaElements,
  selectMediaCandidate,
  type PageMediaElement,
} from "../src/media-control-selection.js";

function media(
  tagName: "AUDIO" | "VIDEO",
  options: {
    readonly paused?: boolean;
    readonly ended?: boolean;
    readonly play?: () => Promise<void>;
  } = {},
): PageMediaElement {
  return {
    tagName,
    paused: options.paused ?? true,
    ended: options.ended ?? false,
    pause: vi.fn(),
    play: options.play ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe("page media candidate selection", () => {
  it("selects the largest visible video", () => {
    const small = media("VIDEO", { paused: false });
    const large = media("VIDEO");
    const playingAudio = media("AUDIO", { paused: false });
    const areas = new Map<PageMediaElement, number>([
      [small, 12_000],
      [large, 90_000],
    ]);

    expect(
      selectMediaCandidate(
        [small, playingAudio, large],
        (candidate) => areas.get(candidate) ?? 0,
      ),
    ).toBe(large);
  });

  it("selects playing media when no video is visible", () => {
    const pausedAudio = media("AUDIO");
    const hiddenVideo = media("VIDEO");
    const playingAudio = media("AUDIO", { paused: false });

    expect(
      selectMediaCandidate(
        [pausedAudio, hiddenVideo, playingAudio],
        () => 0,
      ),
    ).toBe(playingAudio);
  });
});

describe("page media operations", () => {
  it("reports blocked playback when play rejects", async () => {
    const video = media("VIDEO", {
      play: vi.fn().mockRejectedValue(
        new DOMException("A gesture is required", "NotAllowedError"),
      ),
    });

    await expect(
      controlMediaElements([video], "play", () => 100),
    ).resolves.toEqual({ status: "blocked" });
  });

  it("reports no media when the page has no candidate", async () => {
    await expect(
      controlMediaElements([], "pause", () => 0),
    ).resolves.toEqual({ status: "no-media" });
  });
});
