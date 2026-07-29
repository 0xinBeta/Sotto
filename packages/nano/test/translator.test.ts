import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BuiltInTranslatorSession,
  createTranslatorSession,
  detectSourceLanguage,
  getTranslatorAvailability,
  normalizeTranslatorLanguage,
} from "../src/translator.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Translator API wrapper", () => {
  it.each([
    "unavailable",
    "downloadable",
    "downloading",
    "available",
  ] as const)("reports pair availability: %s", async (availability) => {
    const api = {
      availability: vi.fn().mockResolvedValue(availability),
    };
    vi.stubGlobal("Translator", api);

    await expect(
      getTranslatorAvailability({
        sourceLanguage: " en ",
        targetLanguage: "es",
      }),
    ).resolves.toBe(availability);
    expect(api.availability).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "es",
    });
  });

  it("reports unavailable when the global is absent or the check fails", async () => {
    vi.stubGlobal("Translator", undefined);
    await expect(
      getTranslatorAvailability({
        sourceLanguage: "en",
        targetLanguage: "fr",
      }),
    ).resolves.toBe("unavailable");

    vi.stubGlobal("Translator", {
      availability: vi.fn().mockRejectedValue(new Error("policy denied")),
    });
    await expect(
      getTranslatorAvailability({
        sourceLanguage: "en",
        targetLanguage: "fr",
      }),
    ).resolves.toBe("unavailable");
  });

  it("creates a pair, reports bounded download progress, and translates text", async () => {
    const model = {
      translate: vi.fn().mockResolvedValue("Hola"),
      destroy: vi.fn(),
    };
    const api = {
      availability: vi.fn().mockResolvedValue("downloadable"),
      create: vi.fn().mockImplementation(
        async (options: {
          readonly monitor: (monitor: {
            addEventListener(
              type: string,
              listener: (event: { readonly loaded: number }) => void,
            ): void;
          }) => void;
        }) => {
          options.monitor({
            addEventListener(type, listener) {
              expect(type).toBe("downloadprogress");
              listener({ loaded: -1 });
              listener({ loaded: 0.4 });
              listener({ loaded: 2 });
            },
          });
          return model;
        },
      ),
    };
    const onDownloadProgress = vi.fn();
    vi.stubGlobal("Translator", api);

    const result = await createTranslatorSession({
      sourceLanguage: "en",
      targetLanguage: "es",
      onDownloadProgress,
    });

    expect(result).toMatchObject({
      ok: true,
      availability: "downloadable",
    });
    expect(onDownloadProgress.mock.calls).toEqual([
      [{ loaded: 0, total: 1 }],
      [{ loaded: 0.4, total: 1 }],
      [{ loaded: 1, total: 1 }],
    ]);
    if (!result.ok) throw new Error("Translator creation failed");
    await expect(result.session.translate("Hello")).resolves.toBe("Hola");
    expect(model.translate).toHaveBeenCalledWith("Hello", undefined);
    result.session.destroy();
    result.session.destroy();
    expect(model.destroy).toHaveBeenCalledOnce();
  });

  it("does not create an unavailable language pair", async () => {
    const api = {
      availability: vi.fn().mockResolvedValue("unavailable"),
      create: vi.fn(),
    };
    vi.stubGlobal("Translator", api);

    await expect(
      createTranslatorSession({
        sourceLanguage: "en",
        targetLanguage: "es",
      }),
    ).resolves.toEqual({
      ok: false,
      availability: "unavailable",
    });
    expect(api.create).not.toHaveBeenCalled();
  });

  it("rejects translation after session destruction", async () => {
    const model = {
      translate: vi.fn(),
      destroy: vi.fn(),
    };
    const session = new BuiltInTranslatorSession(
      model as unknown as Translator,
    );

    session.destroy();

    await expect(session.translate("Hello")).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    expect(model.translate).not.toHaveBeenCalled();
  });
});

describe("Language Detector API wrapper", () => {
  it("normalizes document language metadata for translator pairs", () => {
    expect(normalizeTranslatorLanguage("pt-BR")).toBe("pt");
    expect(normalizeTranslatorLanguage("zh_TW")).toBe("zh-Hant");
    expect(normalizeTranslatorLanguage("zh-Hans-CN")).toBe("zh");
    expect(normalizeTranslatorLanguage("invalid language")).toBeUndefined();
  });

  it("uses the detected language and destroys the detector", async () => {
    const detector = {
      detect: vi.fn().mockResolvedValue([
        { detectedLanguage: "de", confidence: 0.98 },
        { detectedLanguage: "nl", confidence: 0.02 },
      ]),
      destroy: vi.fn(),
    };
    const api = {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockResolvedValue(detector),
    };
    vi.stubGlobal("LanguageDetector", api);

    await expect(
      detectSourceLanguage("Guten Morgen", {
        fallbackLanguage: "en-US",
      }),
    ).resolves.toBe("de");
    expect(detector.detect).toHaveBeenCalledWith("Guten Morgen", {});
    expect(detector.destroy).toHaveBeenCalledOnce();
  });

  it("reports detector download progress before using its result", async () => {
    const onDownloadProgress = vi.fn();
    const detector = {
      detect: vi.fn().mockResolvedValue([
        { detectedLanguage: "fr", confidence: 0.9 },
      ]),
      destroy: vi.fn(),
    };
    vi.stubGlobal("LanguageDetector", {
      availability: vi.fn().mockResolvedValue("downloadable"),
      create: vi.fn().mockImplementation(
        async (options: {
          readonly monitor: (monitor: {
            addEventListener(
              type: string,
              listener: (event: { readonly loaded: number }) => void,
            ): void;
          }) => void;
        }) => {
          options.monitor({
            addEventListener(_type, listener) {
              listener({ loaded: 0.25 });
            },
          });
          return detector;
        },
      ),
    });

    await expect(
      detectSourceLanguage("Bonjour", { onDownloadProgress }),
    ).resolves.toBe("fr");
    expect(onDownloadProgress).toHaveBeenCalledWith({
      loaded: 0.25,
      total: 1,
    });
  });

  it("uses the document language when detection is absent or fails", async () => {
    vi.stubGlobal("LanguageDetector", undefined);
    await expect(
      detectSourceLanguage("Olá", { fallbackLanguage: "pt-BR" }),
    ).resolves.toBe("pt");

    vi.stubGlobal("LanguageDetector", {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockRejectedValue(new Error("model failed")),
    });
    await expect(
      detectSourceLanguage("繁體中文", { fallbackLanguage: "zh-TW" }),
    ).resolves.toBe("zh-Hant");
  });
});
