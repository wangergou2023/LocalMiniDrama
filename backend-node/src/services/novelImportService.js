/**
 * 小说/长文章节导入服务
 * 功能：上传 txt/docx 内容 → AI 识别章节分割 → 自动填充各集剧本
 */
const aiClient = require('./aiClient');
const { safeParseAIJSON } = require('../utils/safeJson');

/**
 * 简单的章节检测（不调用 AI，基于规则）
 * 识别常见章节标题格式
 *
 * 两处必须分组的理由：
 *   · 命名型（第N章/节/集，含漏写「第」的「十二集」）是**可靠**的章节标记；
 *   · 松散型（`1.标题` / `【标题】` / `「标题」`）只是猜的 —— 策划案/剧本里的
 *     `1.基本信息`、`1.景：吴家`、`2.1女主-韩悠兰` 全都会被它命中。
 *   所以只要文本里存在命名型标记，就**只用命名型**，松散型只在不含命名型时才启用。
 *   （实测《重生后过上了大女主生活》：把两种混着用会切出 48 个假章节，
 *   其中 `1.景：吴家` 这种场景标签居多。）
 */
// 漏写「第」：整行 = 数字 + 章/节/集（+ 不超过 12 字且不含句读的副标题）
const BARE_CHAPTER_RE = /^((?:[零一二三四五六七八九十百千]|\d|[\uFF10-\uFF19]){1,4}\s*(?:章|节|集))\s*[^，。！？：；、,.!?;:"'“”‘’「」『』（）()《》〈〉【】\[\]\-—…\s]{0,12}$/;

const NAMED_CHAPTER_PATTERNS = [
  /^第\s*(?:[零一二三四五六七八九十百千]|\d|[\uFF10-\uFF19])+\s*(?:章|节|集)/,
  BARE_CHAPTER_RE,
  /^Chapter\s+\d+/i,
  /^CHAPTER\s+\d+/,
];
const LOOSE_CHAPTER_PATTERNS = [
  /^\d+[\.、]\s*.{2,20}$/,
  /^【.{1,30}】$/,
  /^「.{1,30}」$/,
];

function detectChaptersByRules(text) {
  const lines = text.split(/\r?\n/);
  const hasNamedChapters = lines.some((l) => {
    const t = l.trim();
    return t && NAMED_CHAPTER_PATTERNS.some((p) => p.test(t));
  });
  const chapterPatterns = hasNamedChapters ? NAMED_CHAPTER_PATTERNS : LOOSE_CHAPTER_PATTERNS;
  const chapters = [];
  let currentStart = 0;
  let currentTitle = '序章';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const isChapter = chapterPatterns.some((p) => p.test(line));
    if (isChapter) {
      if (i > currentStart) {
        const content = lines.slice(currentStart, i).join('\n').trim();
        if (content.length > 20) {
          chapters.push({ title: currentTitle, content });
        }
      }
      // 只有「漏写第」那种裸标题才补「第」，松散模式（【标题】/「标题」）原样保留
      currentTitle = BARE_CHAPTER_RE.test(line) ? `第${line.replace(/\s+/g, '')}` : line;
      currentStart = i + 1;
    }
  }
  // 最后一章
  const lastContent = lines.slice(currentStart).join('\n').trim();
  if (lastContent.length > 20) {
    chapters.push({ title: currentTitle, content: lastContent });
  }
  return chapters;
}

/**
 * 用 AI 将章节内容摘要为剧本形式
 */
async function summarizeChapterToScript(db, log, chapterTitle, chapterContent, dramaTitle) {
  const maxLen = 2000;
  const truncated = chapterContent.length > maxLen ? chapterContent.slice(0, maxLen) + '...' : chapterContent;
  const userPrompt = `小说名称：${dramaTitle || '未知'}
章节标题：${chapterTitle}

章节原文（部分）：
${truncated}

请将上述章节内容改写为短剧剧本格式，包含：场景描述、角色对话、动作说明。输出为中文纯文本，不需要 JSON 格式，长度200-500字。`;

  try {
    const result = await aiClient.generateText(db, log, 'text', userPrompt, null, {
      scene_key: 'novel_import',
      max_tokens: 800,
      temperature: 0.7,
    });
    return result || chapterContent.slice(0, 500);
  } catch (err) {
    log.warn('[小说导入] AI改写章节失败，使用原文截断', { error: err.message });
    return chapterContent.slice(0, 500);
  }
}

/**
 * 主入口：解析小说文本，返回章节列表
 * @returns {{ chapters: Array<{title, content, script}> }}
 */
async function importNovel(db, log, { text, title, maxChapters, aiSummarize }) {
  if (!text || !text.trim()) throw new Error('小说内容不能为空');

  const all = detectChaptersByRules(text);
  if (all.length === 0) {
    // 没有检测到章节，整个文本作为一章
    all.push({ title: title || '第一集', content: text.trim() });
  }

  // 第一个章节标题之前的内容（策划案/人物小传/故事大纲）单独摘出来，交给调用方写进「故事梗概」。
  // 不摘的话它会挂在第一集头上：实测一份 5992 字策划案把第一集撑到 6671 字，
  // 按「每集约 740 字」的规划折算 ≈ 200 个分镜，生成分镜时模型还会把人物小传当剧情。
  let preamble = '';
  if (all.length > 1 && all[0].title === '序章') {
    const first = all[0].content || '';
    // 真的是「序章/楔子/引子」正文时保留成章节，只有纯粹的策划案前言才摘走
    if (!/^\s*(序章|楔子|引子|序言|前言)\s*$/m.test(first)) {
      preamble = first;
      all.shift();
    }
  }
  const chapters = all;

  const limit = Math.min(maxChapters || 20, chapters.length);
  const result = [];

  for (let i = 0; i < limit; i++) {
    const ch = chapters[i];
    let script = ch.content;
    if (aiSummarize) {
      script = await summarizeChapterToScript(db, log, ch.title, ch.content, title);
    }
    result.push({
      index: i + 1,
      title: ch.title,
      content: ch.content.slice(0, 300),
      script,
    });
  }

  return { chapters: result, total: chapters.length, preamble };
}

module.exports = { importNovel, detectChaptersByRules };
