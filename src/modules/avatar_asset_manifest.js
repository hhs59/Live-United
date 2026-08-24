export const DEFAULT_LAYERED_AVATAR_MANIFEST_URL =
  'assets/avatar/characters/uni-3d/manifest.json';

async function loadImage(url) {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  if (image.decode) await image.decode();
  else await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
  });
  return image;
}

export async function loadLayeredAvatarPackage({
  manifestUrl = DEFAULT_LAYERED_AVATAR_MANIFEST_URL,
} = {}) {
  const response = await fetch(manifestUrl, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Unable to load avatar manifest: HTTP ${response.status}.`);

  const manifest = await response.json();
  const baseUrl = new URL(manifestUrl, location.href);
  const layers = await Promise.all(manifest.layers.map(async (layer, manifestIndex) => ({
    ...layer,
    layout: layer.layout || { x: 0, y: 0, width: 1, height: 1 },
    manifestIndex,
    image: await loadImage(new URL(layer.asset, baseUrl)),
  })));

  return {
    manifest,
    sourceWidth: manifest.canvas.width,
    sourceHeight: manifest.canvas.height,
    layers: layers.sort((a, b) => a.zIndex - b.zIndex || a.manifestIndex - b.manifestIndex),
    slots: manifest.slots,
  };
}
