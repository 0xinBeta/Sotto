export const GUIDED_DEMO_RETIRED_KEY = "guidedDemoRetired";
export const GUIDED_DEMO_STARTER_INDEX_KEY = "guidedDemoStarterIndex";

export const GUIDED_DEMO_STARTERS = [
  "guidedDemoScreenshot",
  "guidedDemoTabCount",
  "guidedDemoSummary",
] as const;

export type GuidedDemoStarter = (typeof GUIDED_DEMO_STARTERS)[number];

export interface GuidedDemoStorage {
  get(keys: readonly string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export interface GuidedDemoOpenState {
  readonly retired: boolean;
  readonly starter: GuidedDemoStarter;
}

export function shouldShowGuidedDemo(
  setupComplete: boolean,
  retired: boolean,
): boolean {
  return setupComplete && !retired;
}

export function nextGuidedDemoStarterIndex(value: unknown): number {
  return typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value < GUIDED_DEMO_STARTERS.length
    ? (value + 1) % GUIDED_DEMO_STARTERS.length
    : 0;
}

export class GuidedDemoStore {
  constructor(private readonly storage: GuidedDemoStorage) {}

  async open(): Promise<GuidedDemoOpenState> {
    const values = await this.storage.get([
      GUIDED_DEMO_RETIRED_KEY,
      GUIDED_DEMO_STARTER_INDEX_KEY,
    ]);
    const retired = values[GUIDED_DEMO_RETIRED_KEY] === true;
    if (retired) {
      return {
        retired: true,
        starter: GUIDED_DEMO_STARTERS[0],
      };
    }

    const index = nextGuidedDemoStarterIndex(
      values[GUIDED_DEMO_STARTER_INDEX_KEY],
    );
    await this.storage.set({
      [GUIDED_DEMO_STARTER_INDEX_KEY]: index,
    });
    return {
      retired: false,
      starter: GUIDED_DEMO_STARTERS[index]!,
    };
  }

  async retire(): Promise<void> {
    await this.storage.set({
      [GUIDED_DEMO_RETIRED_KEY]: true,
    });
  }
}
