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

export default defineConfig({
  plugins: [
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
          src: `${ortVadDist}/*.{wasm,mjs}`,
          dest: "assets/ort-vad",
          rename: { stripBase: true },
        },
        {
          src: `${ortTransformersDist}/*.{wasm,mjs}`,
          dest: "assets/ort-transformers",
          rename: { stripBase: true },
        },
      ],
    }),
    placeholderIcons(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        background: resolve(extensionRoot, "src/background.ts"),
        sidepanel: resolve(extensionRoot, "sidepanel.html"),
        offscreen: resolve(extensionRoot, "offscreen.html"),
        requestMic: resolve(extensionRoot, "request-mic.html"),
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
