/**
 * 从剧本文本中按行首「第…集 / 章 / 节」拆分为多集（与小说导入规则一致，且支持同集标题后紧跟正文）。
 *
 * 也认**漏写「第」字**的标题（实测《重生后过上了大女主生活》里第十二集写成「十二集」，
 * 于是整集正文被并进第十一集，20 集变 19 集 —— 那种一集明显比别人长一截的就是这个征兆）。
 * 这种裸写法必须整行只有「数字+集/章/节」（可带 ≤12 字、不含句读的副标题），
 * 否则剧本里的「1.景：吴家」「3.故事大纲」也会被当成集标题。
 *
 * @param {string} text
 * @returns {{ split: boolean, episodes: Array<{ title: string, script_content: string }> }}
 */
export function parseScriptIntoEpisodes(text) {
  const raw = (text ?? '').toString()
  const trimmedAll = raw.trim()
  if (!trimmedAll) {
    return { split: false, episodes: [] }
  }

  const markerRe =
    /^(第\s*(?:[零一二三四五六七八九十百千]|\d|[\uFF10-\uFF19])+\s*(?:集|章|节))\s*(.*)$/

  /** 漏写「第」的标题：整行 = 数字 + 集/章/节（+ 不超过 12 字且不含句读的副标题） */
  const bareMarkerRe =
    /^((?:[零一二三四五六七八九十百千]|\d|[\uFF10-\uFF19]){1,4}\s*(?:集|章|节))\s*([^，。！？：；、,.!?;:"'“”‘’「」『』（）()《》〈〉【】\[\]\-—…\s]{0,12})$/

  /** 行首各类括号包住「第…集/章/节」时，先展平成「第一集 …」再匹配 markerRe */
  const TITLE_IN_EP =
    '第\\s*(?:[零一二三四五六七八九十百千]|\\d|[\\uFF10-\\uFF19])+\\s*(?:集|章|节)'
  /** 漏写「第」的标题（十二集）也可能被括号包住 */
  const TITLE_BARE_EP = '(?:[零一二三四五六七八九十百千]|\\d|[\\uFF10-\\uFF19]){1,4}\\s*(?:集|章|节)'
  const EP_LINE_UNWRAPPERS = [
    new RegExp(`^【\\s*(${TITLE_IN_EP})(?:\\s*】\\s*|\\s{1,})(.*)$`),
    new RegExp(`^《\\s*(${TITLE_IN_EP})(?:\\s*》\\s*|\\s{1,})(.*)$`),
    new RegExp(`^<\\s*(${TITLE_IN_EP})(?:\\s*>\\s*|\\s{1,})(.*)$`),
    new RegExp(`^＜\\s*(${TITLE_IN_EP})(?:\\s*＞\\s*|\\s{1,})(.*)$`),
    // ASCII [ … ] / [ … 】 / [ … 正文
    new RegExp(`^\\[\\s*(${TITLE_IN_EP})(?:\\s*\\]\\s*|\\s*】\\s*|\\s{1,})(.*)$`),
    new RegExp(`^［\\s*(${TITLE_IN_EP})(?:\\s*］\\s*|\\s{1,})(.*)$`),
    // 括号里漏写「第」：实测小说里出现过「十二集」这种标题
    new RegExp(`^【\\s*(${TITLE_BARE_EP})\\s*】\\s*(.*)$`),
    new RegExp(`^「\\s*(${TITLE_BARE_EP})\\s*」\\s*(.*)$`),
    new RegExp(`^\\[\\s*(${TITLE_BARE_EP})\\s*\\]\\s*(.*)$`),
  ]

  function normalizeLineForEpisodeMarkers(trimmedLine) {
    const t = trimmedLine
    if (!t) return t
    for (const re of EP_LINE_UNWRAPPERS) {
      const um = re.exec(t)
      if (um) {
        const titlePart = (um[1] || '').trim()
        const bodyPart = (um[2] ?? '').trim()
        return bodyPart ? `${titlePart} ${bodyPart}` : titlePart
      }
    }
    return t
  }

  const lines = raw.split(/\r?\n/)
  const segments = []
  let preamble = []
  let current = null

  function flush() {
    if (!current) return
    const script_content = current.lines.join('\n').replace(/\s+$/, '')
    segments.push({ title: current.title, script_content })
    current = null
  }

  for (const line of lines) {
    const t = normalizeLineForEpisodeMarkers(line.trim())
    const m = t.match(markerRe)
    const bare = m ? null : t.match(bareMarkerRe)
    if (m || bare) {
      if (current) flush()
      // 裸标题补上「第」，和其余集的标题格式统一（「十二集」→「第十二集」）
      const title = m ? m[1] : `第${bare[1].replace(/\s+/g, '')}`
      current = { title, lines: preamble.length ? [...preamble] : [] }
      preamble = []
      const tail = m ? (m[2] ?? '') : (bare[2] ?? '')
      if (tail.length) current.lines.push(tail)
    } else if (!current) {
      preamble.push(line)
    } else {
      current.lines.push(line)
    }
  }
  flush()

  if (segments.length === 0) {
    return { split: false, episodes: [{ title: '', script_content: trimmedAll }] }
  }

  const split = segments.length >= 2
  return { split, episodes: segments }
}

/**
 * 将分集列表拼成纯文本（每集「标题」与正文分行），便于再次保存时按行首标题拆分。
 * @param {Array<{ title: string, script_content?: string }>} episodes
 */
export function episodesListToPlainScript(episodes) {
  if (!episodes?.length) return ''
  return episodes
    .map((e) => {
      const t = (e.title || '').trim()
      const body = (e.script_content ?? '').toString().replace(/\s+$/, '')
      return body ? `${t}\n${body}` : t
    })
    .filter(Boolean)
    .join('\n\n')
}
