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
  // 镜内剪辑点（H3 原生多镜头）：打斗镜该切拍却还是单镜 —— 见 universalOmniMultiBeatFormat 顶部注释。
  const fightsWithoutCuts = formatReport ? Number(formatReport.fights_without_cuts) || 0 : 0;
  const cutsWithoutFight = formatReport ? Number(formatReport.cuts_without_fight) || 0 : 0;
  const multiShot = formatReport ? Number(formatReport.multi_shot) || 0 : 0;

  // 报告是在流程的哪一步算的。**这点很重要**：生成任务结束时算的那份，校验的是
  // 「前端润色之前」的文本；而前端随后会逐条重写 universal_segment_text（实测 21 条约 80 秒），
  // 所以那份报告的格式结论对最终文本并不成立。润色完成后前端会再调一次并刷新，
  // stage 标成 after_polish，界面据此提示用户「这份是最终文本的结论」。
  const stage = ['generation', 'after_polish', 'manual'].includes(opts.stage) ? opts.stage : 'generation';
  // 标签与一句话说明都要让用户看懂「这份结论对应的是哪一版文本」——
  // 初版只写了「生成时自检（润色前）」，用户直接问「这个是啥意思」，说明没做到。
  const stageLabel = stage === 'after_polish'
    ? '复核 · 对应最终文本'
    : stage === 'manual'
      ? '手动自检'
      : '初检 · 润色前';
  const stageHint = stage === 'after_polish'
    ? '润色已完成，这份结论对应的就是你最终看到的正文。'
    : stage === 'manual'
      ? '这是你手动触发的一次重算，对应库里当前文本。'
      : '「生成分镜」刚跑完时的初检。前端随后会自动逐条润色正文（重写画面描述），润色完成后本报告会自动重算一次，标签变为「复核 · 对应最终文本」。';

  const reasons = [];
  let verdict = 'ok';
  let hasMissingDialogue = false;
  let hasFatal = false;
  let hasMissingBeats = false;
  let hasRepairs = false;
  let hasFightsWithoutCuts = false;
  let hasCutsWithoutFight = false;

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
  // 打斗镜「定场挤压」：不是格式错误（正文完全合规），但它会让打斗**看不出来** ——
  // 实测问题镜是 9 秒里 8 秒定场、交锋只在最后 0.8 秒（正文里第一个交锋动作出现在 70% 处）。
  //
  // 注意这里**不是**「打斗镜没切拍就报警」。初版就是那样写的，在 drama4 的 65 镜上产生了
  // 8 条假警、0 条真问题：短交锋（1-2 拍）本来就该单镜；已在分镜层面拆成连续镜的打斗段
  // 也不需要镜内切拍。假警比不检查更糟 —— 它会让用户重写本来正确的分镜，
  // 并教会用户忽略这份报告。判定规则见 checkFightPacing。
  if (fightsWithoutCuts > 0) {
    if (verdict === 'ok') verdict = 'warn';
    hasFightsWithoutCuts = true;
    reasons.push(
      `有 ${fightsWithoutCuts} 个打斗镜把大部分时长花在定场与运镜上（正文里第一个交锋动作出现在 ` +
      `55% 之后，镜头又不短）——这样渲染出来多半是「大半时长在介绍环境、交锋只挤在最后一瞬」。` +
      `可在这些镜上点「生成全能提示词」重写一次（会按拍切成 [Shot N] 多镜）`
    );
  }
  if (cutsWithoutFight > 0) {
    if (verdict === 'ok') verdict = 'warn';
    hasCutsWithoutFight = true;
    reasons.push(
      `有 ${cutsWithoutFight} 个非打斗镜切了镜内拍（可能是模型自行加的）——若这些镜本来是一段连续表演，建议改回单镜，避免画面被无谓打散`
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
  } else if (hasMissingBeats && (hasRepairs || hasFightsWithoutCuts)) {
    headline = '可出片，但有节拍缺失待确认（含待修项）';
  } else if (hasMissingBeats) {
    headline = '可出片，但有节拍缺失待确认';
  } else if (hasFightsWithoutCuts) {
    headline = '可出片（有打斗镜定场过长待修）';
  } else if (hasRepairs || hasCutsWithoutFight) {
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
    stage,
    stage_label: stageLabel,
    stage_hint: stageHint,
    computed_at: new Date().toISOString(),
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
      multi_shot: multiShot,
      // fights_without_cuts = **定场挤压**的镜数（真问题），不是「所有没切拍的打斗镜」
      fights_without_cuts: fightsWithoutCuts,
      cuts_without_fight: cutsWithoutFight,
      fight_total: formatReport ? Number(formatReport.fight_total) || 0 : 0,
      fight_cut: formatReport ? Number(formatReport.fight_cut) || 0 : 0,
      fight_split_sequence: formatReport ? Number(formatReport.fight_split_sequence) || 0 : 0,
      fight_single_beat: formatReport ? Number(formatReport.fight_single_beat) || 0 : 0,
    },
    missing_dialogue: missingDialogue.map((m) => ({ speaker: m.speaker || '', line: m.line || '' })),
    missing_beats: missingBeats.map((b) => ({ beat: b.beat || '', reason: b.reason || '' })),
    fights_without_cuts: formatReport && Array.isArray(formatReport.fights_without_cuts_sample)
      ? formatReport.fights_without_cuts_sample
      : [],
    cuts_without_fight: formatReport && Array.isArray(formatReport.cuts_without_fight_sample)
      ? formatReport.cuts_without_fight_sample
      : [],
    shots,
  };
}

module.exports = { buildStoryboardQualityReport };
