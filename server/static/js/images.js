// 画像の縮小・再エンコード（design D3）。
//  File/Blob → canvas に描画して長辺 ≤ MAX_EDGE に縮小 → JPEG(q≈0.85) の data URL 化。
//  十分小さい PNG（透過スクショ等）は再エンコードせず素通しして透過を保つ。
//  EXIF 回転は createImageBitmap({ imageOrientation: 'from-image' }) で最小対応（未対応環境は
//  <img> フォールバックでブラウザの既定回転に任せる）。ローカル完結（外部送信ゼロ・design D2）。

const MAX_EDGE = 1600; // 縮小後の長辺上限（px）
const JPEG_QUALITY = 0.85; // 再エンコード品質
const PNG_PASSTHROUGH_MAX = 512 * 1024; // これ未満の PNG は無劣化で素通し

/** File/Blob が画像か（type が image/*）。 */
export function isImageFile(file) {
  return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
}

/** Blob → data URL（base64）。 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('画像の読み込みに失敗しました'));
    fr.readAsDataURL(blob);
  });
}

/** File/Blob → 描画可能ソース { width, height, drawable, close() }（EXIF 回転補正つき）。 */
async function loadDrawable(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { width: bmp.width, height: bmp.height, drawable: bmp, close: () => bmp.close && bmp.close() };
    } catch {
      /* 一部ブラウザは options 付き createImageBitmap 非対応 → <img> へフォールバック */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('画像をデコードできませんでした'));
      im.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight, drawable: img, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 画像を縮小・再エンコードして data URL を返す。
 * 小さい PNG は素通し、それ以外は長辺 ≤ MAX_EDGE の JPEG へ再エンコードする。
 */
export async function shrinkImage(file) {
  if (!isImageFile(file)) throw new Error('画像ファイルではありません');
  if (file.type === 'image/png' && file.size <= PNG_PASSTHROUGH_MAX) {
    return blobToDataUrl(file); // 透過保持・十分小さいので無劣化で送る
  }
  const src = await loadDrawable(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(src.width, src.height, 1));
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const cx = canvas.getContext('2d');
    cx.drawImage(src.drawable, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } finally {
    src.close();
  }
}
