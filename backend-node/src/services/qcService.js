// 视觉质检服务:生成图后用视觉模型按提示词/构图打分,低分/有瑕疵标记需重生成
// 依赖 aiClient.generateTextWithVision(已支持本地路径 / URL / dataURL)
const aiClient = require('./aiClient');

// 助手质检用的视觉模型(在「AI 配置」中单独配置,不占用主文本默认)
const QC_VISION_MODEL = 'deepseek-v4-flash-vision-exp-hermes';

// 质检 prompt:给出结构化 JSON 输出
const QC_SYSTEM = `你是一位严格的影视分镜质检。根据"原图提示词"与"质检期望"评审给定图片,只输出 JSON,不要多余文字。
JSON 结构:{"score":0到100的整数,"ok":布尔,"issues":["问题1",...],"reason":"一句话结论"}`;

function buildUserPrompt(prompt, expect) {
  const parts = [];
  if (prompt) parts.push(`【原图提示词】\n${prompt}`);
  if (expect) parts.push(`【质检期望】\n${expect}`);
  parts.push(`请判断:构图/景别是否准确,主体是否清晰一致,有无畸变/多余肢体/水印/乱码/文字伪影,角色是否像同一个人。评分:≥70 为 ok,<70 或检出上述硬伤则为 ok=false。`);
  return parts.join('\n\n');
}

/**
 * 质检一张图
 * @param {object} db
 * @param {object} log
 * @param {object} opts { image, prompt, expect? }
 *   image: 本地路径(local_path)或 http(s) URL 或 dataURL
 * @returns {Promise<{score:number, ok:boolean, issues:string[], reason:string, error?:string}>}
 */
async function qcImage(db, log, opts) {
  const image = opts?.image;
  if (!image) return { score: 0, ok: false, issues: ['缺少图片'], reason: '未提供图片' };
  const prompt = opts?.prompt || '';
  const expect = opts?.expect || '';

  // 图片源转换:统一成视觉模型要求的 {imageUrl} 或 {localAbsPath} 对象
  const imgSrc = resolveImageForVision(db, image, opts);
  if (!imgSrc) return { score: 0, ok: false, issues: ['图片无法解析'], reason: '图片不可访问' };

  try {
    const raw = await aiClient.generateTextWithVision(db, log, 'vision', buildUserPrompt(prompt, expect), QC_SYSTEM, imgSrc, {
      model: QC_VISION_MODEL,
      max_tokens: 800,
      temperature: 0.2,
    });
    return parseQcResult(raw);
  } catch (e) {
    log && log.warn && log.warn('qcImage AI 调用失败', { error: e.message });
    return { score: 0, ok: false, issues: [], reason: '质检模型调用失败: ' + e.message, error: e.message };
  }
}

/** 将图片输入统一成视觉模型可接受的对象 {imageUrl} / {localAbsPath} */
function resolveImageForVision(db, image, opts) {
  const s = String(image || '').trim();
  if (!s) return null;
  if (/^data:image\//i.test(s)) return { imageUrl: s };
  if (/^https?:\/\//i.test(s)) return { imageUrl: s };
  // 本地存储相对路径(projects/...):优先转 /static URL;绝对路径走 localAbsPath
  const cfg = opts?.cfg || {};
  if (/^projects\//i.test(s)) {
    const baseUrl = cfg?.storage?.base_url || '';
    if (baseUrl) return { imageUrl: `${baseUrl.replace(/\/$/, '')}/static/${s}` };
    return { localAbsPath: s };
  }
  if (require('fs').existsSync(s)) return { localAbsPath: s };
  return null;
}

/** 容错解析模型返回的 JSON(可能被 ``` 包裹或有杂讯) */
function parseQcResult(raw) {
  const text = String(raw || '');
  let jsonStr = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) jsonStr = fence[1];
  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start >= 0 && end > start) jsonStr = jsonStr.slice(start, end + 1);
  try {
    const o = JSON.parse(jsonStr);
    const score = Math.max(0, Math.min(100, Number(o.score) || 0));
    const ok = typeof o.ok === 'boolean' ? o.ok : score >= 70;
    return { score, ok, issues: Array.isArray(o.issues) ? o.issues.slice(0, 6) : [], reason: String(o.reason || '').slice(0, 160) };
  } catch (_) {
    // 非 JSON:启发式判定
    return { score: 0, ok: false, issues: [], reason: '质检输出无法解析,请人工查看' };
  }
}

module.exports = { qcImage, parseQcResult };
