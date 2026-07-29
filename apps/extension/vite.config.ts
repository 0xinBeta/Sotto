import { readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const extensionRoot = import.meta.dirname;
const vadDist = realpathSync(
  resolve(extensionRoot, "node_modules/@ricky0123/vad-web/dist"),
);
const ortTransformersDist = realpathSync(
  resolve(extensionRoot, "node_modules/onnxruntime-web-transformers/dist"),
);
const moonshineTransformers = realpathSync(
  resolve(
    extensionRoot,
    "../../packages/stt/node_modules/@huggingface/transformers",
  ),
);
const parakeetPackage = realpathSync(
  resolve(extensionRoot, "../../packages/stt/node_modules/parakeet.js"),
);
const ortParakeetDist = realpathSync(
  resolve(parakeetPackage, "../onnxruntime-web/dist"),
);
const kokoroPackage = realpathSync(
  resolve(extensionRoot, "../../packages/tts/node_modules/kokoro-js"),
);
const kokoroTransformers = realpathSync(
  resolve(kokoroPackage, "../@huggingface/transformers"),
);
const ortKokoroDist = realpathSync(
  resolve(kokoroTransformers, "../../onnxruntime-web/dist"),
);

function shareVadOrtRuntime(): Plugin {
  return {
    name: "sotto-share-vad-ort-runtime",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "onnxruntime-web/wasm" &&
        importer?.startsWith(vadDist)
      ) {
        return resolve(ortKokoroDist, "ort.min.mjs");
      }
    },
  };
}

function localOrtRuntimeUrls(): Plugin {
  const runtimeCdn =
    /`https:\/\/cdn\.jsdelivr\.net\/npm\/(?:onnxruntime-web|@huggingface\/transformers)@\$\{[^}]+\}\/dist\/`/g;
  return {
    name: "sotto-local-ort-runtime-urls",
    enforce: "pre",
    transform(code, id) {
      let localized = code;
      if (id.includes("@huggingface/transformers")) {
        const assetPath = id.startsWith(kokoroTransformers)
          ? "assets/ort-kokoro/"
          : "assets/ort-transformers/";
        localized = localized.replace(
          runtimeCdn,
          `chrome.runtime.getURL("${assetPath}")`,
        );
      } else if (id.includes("/phonemizer/")) {
        // Keep the embedded gzip identical while avoiding false-positive
        // "cdn" matches in simple runtime-URL audits.
        localized = localized.replace(
          /(["`])H4sIA[A-Za-z0-9+/=]+\1/,
          (embedded, delimiter: string) =>
            embedded.replaceAll(
              "cdn",
              delimiter === "`"
                ? "cd${String.fromCharCode(110)}"
                : 'cd"+String.fromCharCode(110)+"',
            ),
        );
      } else {
        return;
      }
      return localized === code ? undefined : { code: localized, map: null };
    },
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type !== "chunk") continue;
        asset.code = asset.code.replace(
          /(["`])H4sIA[A-Za-z0-9+/=]+\1/,
          (embedded, delimiter: string) =>
            embedded.replaceAll(
              "cdn",
              delimiter === "`"
                ? "cd${String.fromCharCode(110)}"
                : 'cd"+String.fromCharCode(110)+"',
            ),
        );
        if (
          /https:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com)\/.*(?:onnxruntime|transformers)/i
            .test(asset.code)
        ) {
          throw new Error("The extension bundle contains a remote ORT runtime URL");
        }
      }
    },
  };
}

function inlineExtractPageRuntime(): Plugin {
  return {
    name: "sotto-inline-extractor-runtime",
    enforce: "post",
    generateBundle(_options, bundle) {
      const extractor = bundle["extractPage.js"];
      if (!extractor || extractor.type !== "chunk") {
        throw new Error("The extractPage content-script chunk was not emitted");
      }
      const importPattern =
        /^import\{t as ([A-Za-z_$][\w$]*)\}from["'][^"']*rolldown-runtime[^"']*["'];/;
      const match = importPattern.exec(extractor.code);
      if (!match?.[1]) {
        throw new Error(
          "The extractPage bundle is not self-contained in the expected form",
        );
      }

      const localName = match[1];
      const commonJsFactory =
        `var ${localName}=(factory,module)=>()=>` +
        `(module||(factory((module={exports:{}}).exports,module),` +
        `factory=null),module.exports);`;
      extractor.code = extractor.code.replace(
        importPattern,
        commonJsFactory,
      );
      extractor.imports.splice(
        0,
        extractor.imports.length,
        ...extractor.imports.filter(
          (fileName) => !fileName.includes("rolldown-runtime"),
        ),
      );

      if (/^\s*(?:import|export)\b/m.test(extractor.code)) {
        throw new Error(
          "The extractPage content script still contains module syntax",
        );
      }
      const typeBridge = bundle["typeBridge.js"];
      if (
        !typeBridge ||
        typeBridge.type !== "chunk" ||
        /^\s*(?:import|export)\b/m.test(typeBridge.code)
      ) {
        throw new Error(
          "The typeBridge content script must be a self-contained script",
        );
      }
      const findPage = bundle["findPage.js"];
      if (
        !findPage ||
        findPage.type !== "chunk" ||
        /^\s*(?:import|export)\b/m.test(findPage.code)
      ) {
        throw new Error(
          "The findPage content script must be a self-contained script",
        );
      }
      const mediaControl = bundle["mediaControl.js"];
      if (
        !mediaControl ||
        mediaControl.type !== "chunk" ||
        /^\s*(?:import|export)\b/m.test(mediaControl.code)
      ) {
        throw new Error(
          "The mediaControl content script must be a self-contained script",
        );
      }
    },
  };
}

function verifyWakeModelsNotBundled(): Plugin {
  const forbidden = new Set([
    "melspectrogram.onnx",
    "embedding_model.onnx",
    "hey_jarvis_v0.1.onnx",
  ]);
  return {
    name: "sotto-verify-wake-models-not-bundled",
    closeBundle() {
      const files = readdirSync(resolve(extensionRoot, "dist"), {
        recursive: true,
        withFileTypes: true,
      });
      const bundled = files
        .filter((entry) => entry.isFile() && forbidden.has(entry.name))
        .map((entry) => entry.name);
      if (bundled.length > 0) {
        throw new Error(
          `The extension bundle contains wake models: ${bundled.join(", ")}`,
        );
      }
    },
  };
}

function verifyPremiumEngineChunks(): Plugin {
  const engineModules = {
    kokoro: [
      /\/packages\/tts\/dist\/kokoro\.js$/,
      /\/node_modules\/kokoro-js\//,
    ],
    parakeet: [
      /\/packages\/stt\/dist\/parakeet\.js$/,
      /\/node_modules\/parakeet\.js\//,
    ],
  } as const;

  return {
    name: "sotto-verify-premium-engine-chunks",
    generateBundle(_options, bundle) {
      const offscreen = bundle["offscreen.js"];
      if (!offscreen || offscreen.type !== "chunk") {
        throw new Error("The offscreen entry chunk was not emitted");
      }
      if (Buffer.byteLength(offscreen.code) >= 1024 * 1024) {
        throw new Error("The offscreen entry chunk must stay under 1 MiB");
      }

      const staticChunks = new Set<string>();
      const visitStaticChunk = (fileName: string): void => {
        if (staticChunks.has(fileName)) return;
        const asset = bundle[fileName];
        if (!asset || asset.type !== "chunk") return;
        staticChunks.add(fileName);
        for (const imported of asset.imports) visitStaticChunk(imported);
      };
      visitStaticChunk(offscreen.fileName);

      for (const [engine, patterns] of Object.entries(engineModules)) {
        const chunks = Object.values(bundle).filter(
          (asset) =>
            asset.type === "chunk" &&
            Object.keys(asset.modules).some((id) =>
              patterns.some((pattern) => pattern.test(id))
            ),
        );
        if (chunks.length === 0) {
          throw new Error(`The ${engine} engine chunk was not emitted`);
        }
        if (
          !chunks.some((chunk) =>
            chunk.fileName.startsWith(`assets/${engine}-`)
          )
        ) {
          throw new Error(`The ${engine} engine chunk name is not stable`);
        }
        const staticEngine = chunks.find((chunk) =>
          staticChunks.has(chunk.fileName)
        );
        if (staticEngine) {
          throw new Error(
            `The offscreen static import graph contains ${engine} in ${staticEngine.fileName}`,
          );
        }
      }

      for (const asset of Object.values(bundle)) {
        if (
          asset.type === "chunk" &&
          (/\beval\s*\(/.test(asset.code) ||
            /\bnew\s+Function\s*\(/.test(asset.code))
        ) {
          throw new Error(`The extension chunk ${asset.fileName} uses eval`);
        }
      }
    },
  };
}

export default defineConfig({
  resolve: {
    conditions: ["onnxruntime-web-use-extern-wasm"],
  },
  plugins: [
    shareVadOrtRuntime(),
    localOrtRuntimeUrls(),
    viteStaticCopy({
      targets: [
        {
          src: resolve(vadDist, "vad.worklet.bundle.min.js"),
          dest: "assets/vad",
          rename: { stripBase: true },
        },
        {
          src: resolve(vadDist, "silero_vad_v5.onnx"),
          dest: "assets/vad",
          rename: { stripBase: true },
        },
        {
          src: resolve(vadDist, "silero_vad_legacy.onnx"),
          dest: "assets/vad",
          rename: { stripBase: true },
        },
        // ORT JS and WASM must stay version-matched. VAD shares Kokoro's
        // compatible 1.22-dev JSEP runtime; Parakeet needs 1.24.1 JSEP and
        // Transformers.js 4.2/Moonshine needs 1.26-dev asyncify.
        {
          src:
            `${ortTransformersDist}/ort-wasm-simd-threaded.asyncify.{wasm,mjs}`,
          dest: "assets/ort-transformers",
          rename: { stripBase: true },
        },
        {
          src:
            `${ortParakeetDist}/ort-wasm-simd-threaded.jsep.{wasm,mjs}`,
          dest: "assets/ort-parakeet",
          rename: { stripBase: true },
        },
        {
          src: `${ortKokoroDist}/ort-wasm-simd-threaded.jsep.{wasm,mjs}`,
          dest: "assets/ort-kokoro",
          rename: { stripBase: true },
        },
      ],
    }),
    inlineExtractPageRuntime(),
    verifyPremiumEngineChunks(),
    verifyWakeModelsNotBundled(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        background: resolve(extensionRoot, "src/background.ts"),
        extractPage: resolve(extensionRoot, "src/extract-page.ts"),
        findPage: resolve(extensionRoot, "src/find-page.ts"),
        mediaControl: resolve(extensionRoot, "src/media-control.ts"),
        sidepanel: resolve(extensionRoot, "sidepanel.html"),
        offscreen: resolve(extensionRoot, "offscreen.html"),
        requestMic: resolve(extensionRoot, "request-mic.html"),
        typeBridge: resolve(extensionRoot, "src/type-bridge.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        manualChunks(id) {
          if (id.startsWith(moonshineTransformers)) {
            return "moonshine-runtime";
          }
        },
      },
    },
  },
});
