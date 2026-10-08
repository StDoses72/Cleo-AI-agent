/** Purpose: Render the Cleo app icon from public/cleo.svg into every packaged format.
 * Input: public/cleo.svg (1024×1024 artboard); an optional output directory as argv[2].
 * Output: cleo.png (1024), cleo-256.png, cleo.ico (Windows), cleo.icns (macOS) next to the SVG.
 * Run with `npm run icons` after editing the SVG; the generated files are checked in. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(ui, "public", "cleo.svg");
const output = process.argv[2] ? resolve(process.argv[2]) : join(ui, "public");
const svg = await readFile(source, "utf8");

/** Rasterise the SVG at an exact pixel size; Chromium re-renders the vectors per size,
 * which keeps small sizes crisp instead of blurring a downscaled 1024px bitmap. */
async function render(page, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><head><style>
    html, body { margin: 0; padding: 0; background: transparent; }
    svg { display: block; width: ${size}px; height: ${size}px; }
  </style></head><body>${svg}</body></html>`);
  return page.screenshot({ type: "png", omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, png }, index) => {
    const entry = directory.subarray(index * 16, index * 16 + 16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...entries.map(entry => entry.png)]);
}

function icns(chunks) {
  const body = chunks.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii"); head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const total = body.reduce((sum, chunk) => sum + chunk.length, 8);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii"); head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...body]);
}

const scratch = await mkdtemp(join(tmpdir(), "cleo-icons-"));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const rendered = new Map();
  for (const size of sizes) rendered.set(size, await render(page, size));
  await writeFile(join(output, "cleo.png"), rendered.get(1024));
  await writeFile(join(output, "cleo-256.png"), rendered.get(256));
  await writeFile(join(output, "cleo.ico"), ico([16, 24, 32, 48, 64, 128, 256].map(size => ({ size, png: rendered.get(size) }))));
  // macOS icon types: icp4/icp5 are 16/32px, ic11/ic12 their @2x variants, ic07–ic10 128–512px, ic13/ic14 the 256/512 @2x variants.
  await writeFile(join(output, "cleo.icns"), icns([
    ["icp4", 16], ["icp5", 32], ["ic11", 32], ["ic12", 64], ["ic07", 128],
    ["ic08", 256], ["ic13", 256], ["ic09", 512], ["ic14", 512], ["ic10", 1024],
  ].map(([type, size]) => ({ type, png: rendered.get(size) }))));
  console.log(`Icons written to ${pathToFileURL(output)}: cleo.png, cleo-256.png, cleo.ico, cleo.icns`);
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
