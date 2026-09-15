/** Some generated PNGs contain an opaque neutral preview matte. Remove only
 * bright neutral pixels connected to the atlas edge; enclosed white clothing
 * stays intact. This import step runs once, before GPU upload and cell slicing. */
export function removePreviewMatte(data: Uint8ClampedArray, width: number, height: number): void {
  // A genuine alpha atlas must retain its authored edges and white fabric.
  for (let p = 3; p < data.length; p += 4) if (data[p] === 0) return;
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  const add = (index: number): void => {
    if (seen[index]) return;
    seen[index] = 1;
    const p = index * 4;
    const min = Math.min(data[p], data[p + 1], data[p + 2]);
    const max = Math.max(data[p], data[p + 1], data[p + 2]);
    if (data[p + 3] > 8 && (min < 210 || max - min > 22)) return;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) { add(x); add((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { add(y * width); add(y * width + width - 1); }
  while (head < tail) {
    const i = queue[head++];
    data[i * 4 + 3] = 0;
    const x = i % width;
    if (x > 0) add(i - 1);
    if (x < width - 1) add(i + 1);
    if (i >= width) add(i - width);
    if (i < width * (height - 1)) add(i + width);
  }
}
