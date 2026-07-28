import { mkdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "apps/extension/icons/sotto.svg");
const outputDir = resolve(root, "apps/extension/public/icons");
const source = await readFile(sourcePath);

// The toolbar icon uses fewer, thicker bars than the full-size mark.
const toolbarSource = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <rect width="16" height="16" rx="3.5" fill="#111311"/>
    <g fill="#e6ff97">
      <rect x="2.5" y="3" width="3" height="10" rx="1.5"/>
      <rect x="7" y="4.5" width="3" height="7" rx="1.5"/>
      <rect x="11.5" y="6" width="2" height="4" rx="1"/>
    </g>
  </svg>
`);

await mkdir(outputDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const outputPath = resolve(outputDir, `icon-${size}.png`);
  const input = size === 16 ? toolbarSource : source;

  await sharp(input)
    .resize(size, size, { fit: "fill" })
    .png({ compressionLevel: 9 })
    .toFile(outputPath);

  const metadata = await sharp(outputPath).metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== size ||
    metadata.height !== size
  ) {
    throw new Error(
      `${relative(root, outputPath)} must be a ${size}x${size} PNG`,
    );
  }

  console.log(
    `${relative(root, outputPath)}: ${metadata.width}x${metadata.height} PNG`,
  );
}
