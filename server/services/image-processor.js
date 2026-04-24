import sharp from 'sharp';

const TARGET_SIZE = 1000;
const WEBP_QUALITY = 82;
const JPG_QUALITY = 82;
const MAX_FILE_SIZE = 200 * 1024;

export async function processImage(inputBuffer, options = {}) {
  const {
    targetSize = TARGET_SIZE,
    webpQuality = WEBP_QUALITY,
    jpgQuality = JPG_QUALITY,
    maxFileSize = MAX_FILE_SIZE,
    backgroundColor = { r: 255, g: 255, b: 255, alpha: 1 },
    outputFormat = 'both',
  } = options;

  const metadata = await sharp(inputBuffer).metadata();
  const { width: origWidth = 0, height: origHeight = 0, format: origFormat } = metadata;

  const isLowRes = origWidth < targetSize && origHeight < targetSize;

  const processed = sharp(inputBuffer)
    .resize(targetSize, targetSize, {
      fit: 'contain',
      background: backgroundColor,
    });

  let webpBuffer = null;
  let jpgBuffer = null;

  if (outputFormat === 'webp' || outputFormat === 'both') {
    webpBuffer = await processed.clone().webp({ quality: webpQuality }).toBuffer();
    if (webpBuffer.length > maxFileSize) {
      const reducedQuality = Math.max(40, webpQuality - 20);
      webpBuffer = await sharp(webpBuffer).webp({ quality: reducedQuality }).toBuffer();
    }
  }

  if (outputFormat === 'jpg' || outputFormat === 'both') {
    jpgBuffer = await processed.clone().jpeg({ quality: jpgQuality }).toBuffer();
  }

  return {
    webp: webpBuffer,
    jpg: jpgBuffer,
    metadata: {
      originalWidth: origWidth,
      originalHeight: origHeight,
      originalFormat: origFormat,
      processedWidth: targetSize,
      processedHeight: targetSize,
      webpSize: webpBuffer?.length || 0,
      jpgSize: jpgBuffer?.length || 0,
      isLowRes,
    },
  };
}

export async function downloadImage(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Todas-PIM/1.0' },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) {
    throw new Error(`Not an image: ${contentType}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, contentType };
}

export async function generateAltText(product, position) {
  const parts = [];
  if (product.vendor) parts.push(product.vendor);
  if (product.title) parts.push(product.title.replace(product.vendor || '', '').trim());
  if (position > 1) parts.push(`bild ${position}`);
  return parts.filter(Boolean).join(' — ') || 'Produktbild';
}

export async function getImageMetadata(buffer) {
  const metadata = await sharp(buffer).metadata();
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    size: buffer.length,
    hasAlpha: metadata.hasAlpha,
  };
}
