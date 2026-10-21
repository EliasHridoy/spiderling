// Builders for synthetic Claude Code transcript records. Real transcripts hold
// private code and prompts, so the tests use made-up records that follow the
// shapes observed in real ones.
let n = 0;
const ts = () => new Date(Date.now() + n++).toISOString(); // records are "now", like live ones

const assistant = (content, extra = {}) => ({
  type: 'assistant',
  timestamp: ts(),
  uuid: `u${n}`,
  message: { id: `msg${n}`, model: 'claude-opus-5-5', content, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } },
  ...extra,
});
const text = (t) => ({ type: 'text', text: t });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, content = 'ok', toolUseResult, extra = {}, isError = false) => ({
  type: 'user',
  timestamp: ts(),
  toolUseResult,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError || undefined }] },
  ...extra,
});

// Feed records to a parser and collect what came out.
function run(parser, records) {
  const events = [];
  const meta = [];
  const usage = [];
  for (const r of records) {
    const out = parser.feed(r);
    if (!out) continue;
    events.push(...out.events);
    meta.push(...out.meta);
    if (out.usage) usage.push(out.usage);
  }
  return { events, meta, usage };
}

module.exports = { assistant, text, toolUse, result, run, ts };
