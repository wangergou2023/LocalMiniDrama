/**
 * 把多张图片 URL 用 canvas 横向拼接成一张 PNG dataURL（模拟 H3 r2v 的 ImageStitch 拼图预览）。
 * @param {string[]} urls 图片地址（同源或允许 CORS）
 * @param {number} gap 拼接间隙，默认 16px
 * @returns {Promise<string>} dataURL（image/png）；任一加载失败则返回 ''；仅 1 张则直接返回该图 dataURL
 */
export async function stitchImageUrls(urls, gap = 16) {
  const list = (Array.isArray(urls) ? urls : urls ? [urls] : []).filter(Boolean)
  if (list.length === 0) return ''
  const imgs = []
  for (const u of list) {
    try { imgs.push(await loadImage(u)) } catch (_) {}
  }
  if (imgs.length === 0) return ''
  if (imgs.length === 1) return toCanvasDataUrl(imgs[0])
  const w = imgs.reduce((a, i) => a + i.width + gap, gap)
  const h = Math.max(...imgs.map((i) => i.height))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  let x = gap
  for (const img of imgs) {
    ctx.drawImage(img, x, Math.round((h - img.height) / 2), img.width, img.height)
    x += img.width + gap
  }
  return canvas.toDataURL('image/png')
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('img load failed: ' + url))
    img.src = url
  })
}

function toCanvasDataUrl(img) {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  c.getContext('2d').drawImage(img, 0, 0)
  return c.toDataURL('image/png')
}

export default stitchImageUrls
