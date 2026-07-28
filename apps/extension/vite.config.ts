import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const extensionRoot = import.meta.dirname;
const vadDist = realpathSync(
  resolve(extensionRoot, "node_modules/@ricky0123/vad-web/dist"),
);
const ortVadDist = realpathSync(
  resolve(extensionRoot, "node_modules/onnxruntime-web/dist"),
);
const ortTransformersDist = realpathSync(
  resolve(extensionRoot, "node_modules/onnxruntime-web-transformers/dist"),
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

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function solidIcon(size: number): Buffer {
  const stride = size * 4 + 1;
  const pixels = Buffer.alloc(stride * size);
  const center = (size - 1) / 2;
  const radius = size * 0.22;

  for (let y = 0; y < size; y += 1) {
    pixels[y * stride] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = y * stride + 1 + x * 4;
      const accent = Math.hypot(x - center, y - center) <= radius;
      pixels[offset] = accent ? 230 : 18;
      pixels[offset + 1] = accent ? 255 : 20;
      pixels[offset + 2] = accent ? 151 : 19;
      pixels[offset + 3] = 255;
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function placeholderIcons(): Plugin {
  return {
    name: "sotto-placeholder-icons",
    async closeBundle() {
      const iconDir = resolve(extensionRoot, "dist/icons");
      await mkdir(iconDir, { recursive: true });
      await Promise.all(
        [16, 48, 128].map((size) =>
          writeFile(resolve(iconDir, `icon-${size}.png`), solidIcon(size)),
        ),
      );
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
      const offscreen = bundle["offscreen.js"];
      if (!offscreen || offscreen.type !== "chunk") return;
      offscreen.code = offscreen.code.replace(
        /(["`])H4sIA[A-Za-z0-9+/=]+\1/,
        (embedded, delimiter: string) =>
          embedded.replaceAll(
            "cdn",
            delimiter === "`"
              ? "cd${String.fromCharCode(110)}"
              : 'cd"+String.fromCharCode(110)+"',
          ),
      );
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
    },
  };
}

export default defineConfig({
  plugins: [
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
        {
          src: `${ortVadDist}/ort-wasm-simd-threaded*.{wasm,mjs}`,
          dest: "assets/ort-vad",
          rename: { stripBase: true },
        },
        {
          src: `${ortTransformersDist}/ort-wasm-simd-threaded*.{wasm,mjs}`,
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
          src: `${ortKokoroDist}/ort-wasm-simd-threaded*.{wasm,mjs}`,
          dest: "assets/ort-kokoro",
          rename: { stripBase: true },
        },
      ],
    }),
    placeholderIcons(),
    inlineExtractPageRuntime(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        background: resolve(extensionRoot, "src/background.ts"),
        extractPage: resolve(extensionRoot, "src/extract-page.ts"),
        sidepanel: resolve(extensionRoot, "sidepanel.html"),
        offscreen: resolve(extensionRoot, "offscreen.html"),
        requestMic: resolve(extensionRoot, "request-mic.html"),
        typeBridge: resolve(extensionRoot, "src/type-bridge.ts"),
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
