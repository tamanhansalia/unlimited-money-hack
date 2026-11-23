// Renders resources/icon.svg into resources/icon.png (1024 px, used by macOS and Linux) and resources/icon.ico
// (Windows). Run `npm run app-icon` after editing the SVG. It runs inside Electron so that Chromium draws the SVG,
// glow filter included, exactly as the app would.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const resources = path.join(__dirname, '..', 'resources');
const svg = fs.readFileSync(path.join(resources, 'icon.svg'), 'utf8');
// Windows draws icons edge to edge, so the .ico crops away the macOS margin around the tile.
const fullBleed = svg.replace(/viewBox="[^"]*"/, 'viewBox="100 100 824 824"');
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

async function render(contents, source, size) {
  const url = 'data:image/svg+xml;base64,' + Buffer.from(source).toString('base64');
  const png = await contents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${size};
      canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('Could not load icon.svg'));
    image.src = ${JSON.stringify(url)};
  })`);
  return Buffer.from(png.slice(png.indexOf(',') + 1), 'base64');
}

// An .ico whose entries are PNG images, which Windows Vista and later read.
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size % 256, 0);
    entry.writeUInt8(size % 256, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(image => image.data)]);
}

app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadURL('about:blank');
  fs.writeFileSync(path.join(resources, 'icon.png'), await render(win.webContents, svg, 1024));
  const images = [];
  for (const size of icoSizes) images.push({ size, data: await render(win.webContents, fullBleed, size) });
  fs.writeFileSync(path.join(resources, 'icon.ico'), ico(images));
  console.log(`app icon: icon.png (1024 px), icon.ico (${icoSizes.join(', ')} px)`);
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
