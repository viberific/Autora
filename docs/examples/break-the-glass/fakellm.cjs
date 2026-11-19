// A scripted stand-in model (OpenAI-style streaming). Replies are queued over /ctl/queue; every request is logged to /ctl/log.
const http = require('http');
const queue = []; const log = [];
const srv = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const url = req.url;
    if (url.startsWith('/ctl/queue') && req.method === 'POST') { const arr = JSON.parse(raw); queue.push(...arr); res.end(JSON.stringify({ queued: queue.length })); return; }
    if (url.startsWith('/ctl/log')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(log.splice(0))); return; }
    if (url.startsWith('/ctl/state')) { res.end(JSON.stringify({ queued: queue.length })); return; }
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'scripted-1' }] })); }
    let body = {}; try { body = JSON.parse(raw); } catch {}
    const messages = body.messages || [];
    const text = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p?.text ?? '').join('') : '';
    const sys = text((messages.find(m => m.role === 'system') || {}).content);
    const last = [...messages].reverse().find(m => m.role === 'user' || m.role === 'tool');
    const housekeeping = /compress an AI agent's working context/.test(sys);
    log.push({ tools: (body.tools || []).map(t => t.function?.name), lastRole: last?.role, last: text(last?.content).slice(0, 6000), housekeeping });
    const reply = housekeeping ? { text: '## Task state\n- (condensed)' } : (queue.shift() || { text: 'ok' });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    for (const w of (reply.text || '').match(/\S+\s*/g) || []) send({ choices: [{ delta: { content: w } }] });
    (reply.tools || []).forEach((t, i) => send({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${log.length}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }] } }] }));
    send({ choices: [{ delta: {}, finish_reason: reply.tools?.length ? 'tool_calls' : 'stop' }] });
    send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    res.write('data: [DONE]\n\n'); res.end();
  });
});
srv.listen(4100, '127.0.0.1', () => console.log('fake llm on 4100'));
