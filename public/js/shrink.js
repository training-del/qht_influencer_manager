/**
 * Shrinks a photo in the phone before it is uploaded.
 *
 * A phone camera writes 3–12 MB per photo, at 12–50 megapixels. A proof photo
 * only has to show a person taking the dava; 1600px on the long side is plenty
 * and comes out around 150–400 KB. That is less mobile data for the influencer,
 * a faster upload on a weak signal, and several times more photos before the
 * free 10 GB of R2 fills up.
 *
 * Done here rather than in the Worker: the free plan gives a Worker ~10 ms of
 * CPU per request and no image library, while the phone has both to spare.
 *
 * Never makes things worse: anything the browser cannot decode (HEIC in some
 * browsers, a broken file) or that would come out larger goes up untouched,
 * and the server's own size limits still apply.
 */

/** The daily proof: a person and a bottle, not a document. */
export const PROOF_PHOTO = { maxSide: 1600, quality: 0.8 };
/** An ID document: larger and sharper, so the printed text stays readable. */
export const ID_PHOTO = { maxSide: 2000, quality: 0.85 };

/** "340 KB", "2.4 MB" */
export const sizeLabel = n =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * @param {File|Blob} file
 * @param {{maxSide: number, quality: number}} opts
 * @returns {Promise<File|Blob>} a smaller JPEG, or the original
 */
export async function shrinkImage(file, { maxSide, quality } = PROOF_PHOTO) {
  if (!file || !/^image\//.test(file.type) || file.type === 'image/gif') return file;

  let bitmap;
  try {
    // from-image: a portrait photo stays portrait (its EXIF rotation is applied)
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;                                   // not decodable here — send as is
  }

  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // JPEG has no transparency; without a ground, a transparent PNG turns black
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;

    const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}
