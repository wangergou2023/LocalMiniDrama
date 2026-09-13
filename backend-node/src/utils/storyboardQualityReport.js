/**
 * 分镜生成「质量报告」——把散在各处的自检结果汇总成一份可读结论。
 *
 * 背景：这条链路原来是「生成 → 存库 → 完」，没有任何自检工序。这个会话里陆续补了
 * 台词覆盖率（utils/dialogueCoverage）和全能提示词骨架校验+修复
 * （universalOmniMultiBeatFormat），但结果只落在后端日志里 —— 用户要自己去翻
 * /tmp/lmd-backend.log 才知道这版能不能用，否则只能靠人肉核对。
 *
 * 本模块把四件事汇成一份结构化报告：
 *   1. 台词覆盖：剧本引号台词是否全部进了某条分镜的 dialogue（确定性字符串比对）
 *   2. 剧情点覆盖：剧本叙事节拍是否落到某一镜（语义判定，由 utils/beatCoverageCheck 的 LLM 调用产出）
 *   3. 格式自检：全能提示词骨架是否有过自动修正、有没有修不好的
 *   4. 基本规格：镜数/总时长 vs 请求值，逐镜清单
 * 并给出一句话结论（可出片 / 建议重跑）与具体理由。
 *
 * 结论分级：失败（fail）只给确定性判定 —— 台词缺失、骨架无法修复；
 * 剧情点缺失属语义判定，降到 warn，清单交人确认。理由：实测关键词/规则式自动判定会误报
 * （把「一棒…身形溃散，化作一道黑烟…消融殆尽」判成「没打死六耳猕猴」、把「把前事细细叙来」
 * 判成「没交代前事」），而 LLM 语义判定在真假美猴王 21 镜上给出 35/35 与人工核对一致。
 */

/** 结论等级：ok 可直接出片 / warn 可出片但有修正 / fail 建议重跑 */
function buildStoryboardQualityReport(opts = {}) {
  const storyboards = Array.isArray(opts.storyboards) ? opts.storyboards : [];
  const coverage = opts.coverage || null;
  const beatCoverage = opts.beatCoverage || null;
  const formatReport = opts.formatReport || null;

  const shotCount = storyboards.length;
  const totalDuration = storyboards.reduce((a, b) => a + (Number(b.duration) || 0), 0);
  const missingDialogue = coverage && Array.isArray(coverage.missing) ? coverage.missing : [];
  const missingBeats = beatCoverage && Array.isArray(beatCoverage.missing) ? beatCoverage.missing : [];
  const universalChecked = formatReport ? Number(formatReport.checked) || 0 : 0;
  const universalRepaired = formatReport ? Number(formatReport.repaired) || 0 : 0;
  const universalFatal = formatReport ? Number(formatReport.fatal) || 0 : 0;

  const reasons = [];
  let verdict = 'ok';
  let hasMissingDialogue = false;
  let hasFatal = false;
  let hasMissingBeats = false;
  let hasRepairs = false;

  if (missingDialogue.length > 0) {
    verdict = 'fail';
    hasMissingDialogue = true;
    reasons.push(
      `有 ${missingDialogue.length} 句剧本台词没有进任何分镜的 dialogue 字段（分镜能承载的台词数约 1 句/镜，镜数不够时会静默丢掉台词）——建议加大「分镜数」重新生成`
    );
  }
  if (universalFatal > 0) {
    verdict = 'fail';
    hasFatal = true;
    reasons.push(
      `有 ${universalFatal} 条全能提示词骨架无法修复，已整条换成块格式兜底模板（模板文出片质量明显低于模型正常产出）——建议单独重跑这几条`
    );
  }
  // 剧情点是语义判定，比字符串比对软，所以只降到 warn：让人看清单自己确认
  if (missingBeats.length > 0 && verdict !== 'fail') {
    verdict = 'warn';
    hasMissingBeats = true;
    reasons.push(
      `语义判定认为有 ${missingBeats.length} 个剧本节拍没落到任何分镜（这是理解式判定、不是字符串比对，可能有误）——请对照下方清单确认，确属缺失就加大「分镜数」重新生成`
    );
  }
  if (universalRepaired > 0) {
    hasRepairs = true;
    if (verdict === 'ok') verdict = 'warn';
    reasons.push(
      `有 ${universalRepaired} 条全能提示词骨架被自动修正（例如风格句写成了「真人写实」与项目风格冲突）——正文已保留，出片不受影响`
    );
  }
  if (shotCount === 0) {
    verdict = 'fail';
    reasons.push('没有生成任何分镜');
  }
  if (reasons.length === 0) reasons.push('剧本台词、剧情节拍与提示词格式自检均通过');

  // 结论标题按**实际原因**拼，不能只看 verdict —— 「缺节拍待确认」和「只是骨架修过」都是 warn，
  // 但前者需要人去看内容、后者无需处理，混用同一个标题会误导。
  let headline;
  if (hasMissingDialogue || hasFatal || shotCount === 0) {
    headline = '建议重跑';
  } else if (hasMissingBeats && hasRepairs) {
    headline = '可出片，但有节拍缺失待确认（含自动修正）';
  } else if (hasMissingBeats) {
    headline = '可出片，但有节拍缺失待确认';
  } else if (hasRepairs) {
    headline = '可出片（有自动修正）';
  } else {
    headline = '可出片';
  }

  const shots = storyboards.map((s, i) => ({
    index: i + 1,
    id: s.id ?? null,
    number: s.storyboard_number ?? null,
    title: s.title || '',
    duration: Number(s.duration) || 0,
    dialogue: (s.dialogue || '').toString().trim(),
    creation_mode: s.creation_mode || null,
  }));

  return {
    verdict,
    headline,
    reasons,
    stats: {
      shot_count: shotCount,
      total_duration: totalDuration,
      requested_count: opts.requestedCount != null ? Number(opts.requestedCount) : null,
      requested_duration: opts.requestedDuration != null ? Number(opts.requestedDuration) : null,
      dialogue_total: coverage ? Number(coverage.total) || 0 : 0,
      dialogue_covered: coverage ? Number(coverage.covered) || 0 : 0,
      dialogue_missing: missingDialogue.length,
      universal_checked: universalChecked,
      universal_repaired: universalRepaired,
      universal_fatal: universalFatal,
      beat_total: beatCoverage ? Number(beatCoverage.total) || 0 : 0,
      beat_covered: beatCoverage ? Number(beatCoverage.covered) || 0 : 0,
      beat_missing: missingBeats.length,
    },
    missing_dialogue: missingDialogue.map((m) => ({ speaker: m.speaker || '', line: m.line || '' })),
    missing_beats: missingBeats.map((b) => ({ beat: b.beat || '', reason: b.reason || '' })),
    shots,
  };
}

module.exports = { buildStoryboardQualityReport };
