import type {
  MediaControlOperation,
  MediaControlResult,
} from "@sotto/core";

export interface PageMediaElement {
  readonly tagName: string;
  readonly paused: boolean;
  readonly ended: boolean;
  pause(): void;
  play(): Promise<void>;
}

type VisibleArea = (media: PageMediaElement) => number;

function visibleVideoArea(media: PageMediaElement): number {
  if (media.tagName.toUpperCase() !== "VIDEO") return 0;
  const element = media as HTMLVideoElement;
  const style = getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    style.opacity === "0"
  ) {
    return 0;
  }
  const rect = element.getBoundingClientRect();
  const width = Math.max(
    0,
    Math.min(rect.right, innerWidth) - Math.max(rect.left, 0),
  );
  const height = Math.max(
    0,
    Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0),
  );
  return width * height;
}

function isPlaying(media: PageMediaElement): boolean {
  return !media.paused && !media.ended;
}

export function selectMediaCandidate(
  media: readonly PageMediaElement[],
  area: VisibleArea = visibleVideoArea,
): PageMediaElement | undefined {
  let largestVideo: PageMediaElement | undefined;
  let largestArea = 0;
  for (const candidate of media) {
    if (candidate.tagName.toUpperCase() !== "VIDEO") continue;
    const candidateArea = area(candidate);
    if (candidateArea > largestArea) {
      largestVideo = candidate;
      largestArea = candidateArea;
    }
  }
  return largestVideo ?? media.find(isPlaying) ?? media[0];
}

export async function controlMediaElements(
  media: readonly PageMediaElement[],
  operation: MediaControlOperation,
  area: VisibleArea = visibleVideoArea,
): Promise<MediaControlResult> {
  const candidate = selectMediaCandidate(media, area);
  if (!candidate) return { status: "no-media" };

  if (operation === "pause") {
    candidate.pause();
    return { status: "paused" };
  }

  try {
    await candidate.play();
    return { status: "playing" };
  } catch {
    return { status: "blocked" };
  }
}
