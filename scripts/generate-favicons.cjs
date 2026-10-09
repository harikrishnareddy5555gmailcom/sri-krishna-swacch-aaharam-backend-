const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const srcPath = path.resolve(__dirname, '../apps/web/public/logo-clean.jpg');
const publicDir = path.resolve(__dirname, '../apps/web/public');

async function makeFavicons() {
  const size = 64;
  const circleSvg = Buffer.from(
    '<svg width="' + size + '" height="' + size + '"><circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + (size / 2) + '" fill="white"/></svg>'
  );

  const circular64 = await sharp(srcPath)
    .resize(size, size, { fit: 'cover' })
    .composite([{ input: circleSvg, blend: 'dest-in' }])
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(publicDir, 'favicon.png'), circular64);
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), circular64);

  const circular32 = await sharp(srcPath)
    .resize(32, 32, { fit: 'cover' })
    .composite([{ input: Buffer.from('<svg width="32" height="32"><circle cx="16" cy="16" r="16" fill="white"/></svg>'), blend: 'dest-in' }])
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(publicDir, 'favicon-32x32.png'), circular32);

  const circular16 = await sharp(srcPath)
    .resize(16, 16, { fit: 'cover' })
    .composite([{ input: Buffer.from('<svg width="16" height="16"><circle cx="8" cy="8" r="8" fill="white"/></svg>'), blend: 'dest-in' }])
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(publicDir, 'favicon-16x16.png'), circular16);

  const base64Png = circular64.toString('base64');
  const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">\n  <image href="data:image/png;base64,' + base64Png + '" width="64" height="64" />\n</svg>\n';
  fs.writeFileSync(path.join(publicDir, 'favicon.svg'), svgContent);

  console.log('Favicons generated successfully!');
}

makeFavicons().catch((err) => {
  console.error(err);
  process.exit(1);
});
