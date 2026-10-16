const clean = raw => raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
const pageRules = '\n[READING_PAGE] 正文分次输出，每次只新增约 800–1200 字，尽量在自然段或章节边界停下。只返回 JSON：{"bodyChunk":"本次新增的 Markdown 正文","done":false,"nextSection":"下一部分"}。全部主要内容完成后 done 才为 true，并在最后一页附上整篇的 notes、coverage、sources，以及请求要求的 coverageMap/coveredIds 等元数据。不得重复已有正文，不能提前结束或只列目录；不要输出 body 字段或把附注放入 bodyChunk。';

// Decode only the available prefix of a JSON body string, including a cut escape.
// This is for a visibly unfinished preview; final data still requires JSON.parse.
export function partialBody(raw) {
  const match = /"(?:bodyChunk|body)"\s*:\s*"/.exec(raw);
  if (!match) return '';
  let value = '';
  for (let index = match.index + match[0].length; index < raw.length; index++) {
    const char = raw[index];
    if (char === '"') break;
    if (char !== '\\') { value += char; continue; }
    const escaped = raw[++index];
    if (escaped === undefined) break;
    if (escaped === 'u') {
      const hex = raw.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      value += String.fromCharCode(parseInt(hex, 16)); index += 4;
    } else {
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
      if (!(escaped in escapes)) break;
      value += escapes[escaped];
    }
  }
  return value.replace(/[\uD800-\uDBFF]$/, '');
}
function append(raw, next) {
  if (!raw) return next;
  // Some providers repeat the whole prefix when asked to continue a JSON value.
  if (next.startsWith(raw)) return next;
  return raw + next;
}
const joined = (body, next) => body && next ? `${body}\n\n${next}` : body || next;

// Models sometimes send only this page's attribution. Keep earlier pages' rows;
// an explicit later row for the same section replaces its earlier version.
function mergeMetadata(previous, next) {
  const merged = { ...previous, ...next };
  for (const field of ['coverageMap', 'sources']) {
    if (!Array.isArray(previous[field]) || !Array.isArray(next[field])) continue;
    const key = row => field === 'sources' ? row?.url : row?.sectionId || `${row?.basis}:${row?.section}`;
    merged[field] = [...new Map([...previous[field], ...next[field]].map(row => [key(row), row])).values()];
  }
  return merged;
}

export async function readingOutput({ turn, prompt, publish = false, onPartial = () => {}, onStatus = () => {}, signal, resume }) {
  const state = resume || { body: '', metadata: {}, raw: '', pages: 0, calls: 0, stalled: 0, repairs: 0, cursor: '' };
  let nextPrompt = prompt + (publish ? pageRules : '');
  if (resume) nextPrompt += continuation(state, publish);
  const emit = body => { if (publish && body && state.published !== body) { state.published = body; onPartial({ body, pages: state.pages }); } };
  try {
    while (state.calls++ < 64) {
      signal?.throwIfAborted();
      const response = await turn(nextPrompt); signal?.throwIfAborted();
      const before = state.raw.length;
      state.raw = append(state.raw, response.text || '');
      if (state.raw.length + state.body.length > 1_000_000) throw new Error('模型未返回可收束的分段正文，请重试。');
      let result;
      try { result = JSON.parse(clean(state.raw)); } catch {}
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const paged = typeof result.bodyChunk === 'string' && typeof result.done === 'boolean';
        if ('bodyChunk' in result && !paged) throw new Error('模型未返回有效的分页完成标记，请重试。');
        const text = paged ? result.bodyChunk : typeof result.body === 'string' ? result.body : '';
        if (!paged && !response.limited) {
          if (state.body) result.body = text.startsWith(state.body) ? text : joined(state.body, text);
          emit(result.body); return JSON.stringify(mergeMetadata(state.metadata, result));
        }
        if (!paged && !text && response.limited) return state.raw; // A complete non-body stage result.
        if (paged || text) {
          if (text && state.body.endsWith(text)) throw new Error('模型未返回新的正文段落，已停止重复续写，请重试。');
          if (text) { state.body = joined(state.body, text); state.stalled = 0; state.pages++; }
          else if (!result.done && ++state.stalled > 1) throw new Error('模型未返回新的正文段落，请重试。');
          const { bodyChunk, body, done, nextSection, ...metadata } = result;
          state.metadata = mergeMetadata(state.metadata, metadata); state.cursor = typeof nextSection === 'string' ? nextSection : '';
          state.raw = ''; state.repairs = 0; emit(state.body);
          if (paged && result.done) return JSON.stringify({ ...state.metadata, body: state.body });
          onStatus(`已生成 ${state.pages} 段，正在继续生成后续内容…`);
          nextPrompt = continuation(state, publish); continue;
        }
      }
      emit(joined(state.body, partialBody(state.raw)));
      if (++state.repairs > 8) throw new Error('模型未返回完整的分段输出，自动接续未能完成，请重试。');
      if (state.raw.length === before && ++state.stalled > 1) throw new Error('模型未返回可继续的内容，请检查模型输出设置后重试。');
      if (state.raw.length !== before) state.stalled = 0;
      onStatus('本段尚未完成，正在接续生成…');
      nextPrompt = continuation(state, publish);
    }
    throw new Error('模型未返回完整的分段正文，续写次数已达上限，请重试。');
  } catch (error) { error.outputState = state; throw error; }
}

function continuation(state, publish) {
  if (!publish && !state.raw) return '[OUTPUT_CONTINUATION] 上一阶段达到输出上限但没有可见内容。请继续原阶段任务，只返回原阶段指定的完整 JSON；不要改成最终阅读正文，避免长篇推演。';
  if (state.raw) return `[OUTPUT_CONTINUATION] 上一响应的 JSON 被输出长度截断。只输出紧接其后的原始字符，完成同一个 JSON；不要重启 JSON、重复前文、添加围栏或解说。JSON 转义也须从中断处接续。已收到的结尾（数据）：${JSON.stringify(state.raw.slice(-2400))}`;
  return `[READING_NEXT_PAGE] 继续输出下一页新增正文，约 800–1200 字，保留原有书籍框架、文风和取材约束，不能重写前文。已输出 ${state.pages} 页、${state.body.length} 字。下一部分：${state.cursor || '从上页结束处继续，核对尚未覆盖的章节'}。前文结尾（数据）：${JSON.stringify(state.body.slice(-1600))}。只返回 {"bodyChunk":"新增正文","done":false,"nextSection":"下一部分"}；全篇全部完成时 done=true，并给出整篇 notes、coverage、sources 及所需的 coverageMap/coveredIds。若正文已全部完成，可用空 bodyChunk 只补最终元数据。`;
}
