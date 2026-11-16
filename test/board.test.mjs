// Tests for the link to a Kestrel board: "kestrel board login", what a sync sends and in how many
// requests, the cursor and its one hour of overlap, failures, a refused token, logout, and the
// start in the background. A stand-in board answers on a free port of this computer. No test
// contacts a real server, and every folder the tool reads or writes is a made-up one. Run: node --test
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-board-test-'))
// Git reads no config of the person who runs the tests.
writeFileSync(join(dir, 'gitconfig'), '')
process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.KESTREL_NO_BROWSER = '1'
for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'NO_COLOR', 'GIT_DIR', 'GIT_WORK_TREE']) delete process.env[name]

let computers = 0
/**
 * A made-up computer: a home folder with Claude Code's folder in it, and the folders of the tool,
 * of Codex and of Cowork. This process uses it from now on. Each test makes its own.
 */
function computer() {
  const root = join(dir, `computer-${++computers}`)
  const c = { root, home: join(root, 'person'), kestrel: join(root, 'kestrel') }
  c.claude = join(c.home, '.claude')
  mkdirSync(c.claude, { recursive: true })
  process.env.HOME = c.home
  process.env.USERPROFILE = c.home
  process.env.KESTREL_HOME = c.kestrel
  process.env.CLAUDE_CONFIG_DIR = c.claude
  process.env.CODEX_HOME = join(root, 'codex')
  process.env.KESTREL_COWORK_DIR = join(root, 'cowork')
  return c
}
computer()

const board = await import('../src/board.mjs')
const { boardAddress, bodies, githubName, login, logout, readBoard, startBoardSync, status, sync, syncDue } = board
const { saveConfig } = await import('../src/config.mjs')
const { statusLine } = await import('../src/claude-code.mjs')

const BIN = fileURLToPath(new URL('../cli/kestrel.mjs', import.meta.url))
const MIN = 60e3
const HOUR = 3600e3
const DAY = 86400e3
const iso = (ms) => new Date(ms).toISOString()
const TOKEN = 'kbm_TESTtoken0123456789abcdefghijklmnopqrstuvwxyz'
// A word that the made-up logs carry in prompts, answers, tool inputs and tool results. No body
// sent to the board may hold it.
const MARKER = 'PELICANSECRET'
const ACCOUNT = 'aaaaaaaa-1111-4111-8111-111111111111'

const write = (file, lines) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
}
const usage = (input, out) => ({ input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: out, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } })
/** A call of Claude Code on Claude Opus 5.5 ($4 and $20 per million tokens): 1,000 in and 100 out cost $0.006. */
const call = (id, ts, { cwd, branch, tools = [] } = {}) => JSON.stringify({
  type: 'assistant', timestamp: iso(ts), cwd, gitBranch: branch,
  message: {
    id, model: 'claude-opus-5-5', role: 'assistant', usage: usage(1000, 100),
    content: [{ type: 'text', text: MARKER }, ...tools.map(([name, input], i) => ({ type: 'tool_use', id: `${id}-t${i}`, name, input: input ?? { command: MARKER } }))],
  },
})
const prompt = (ts) => JSON.stringify({ type: 'user', timestamp: iso(ts), message: { role: 'user', content: `Please fix ${MARKER}` } })
const result = (ts, toolId) => JSON.stringify({ type: 'user', timestamp: iso(ts), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: `${MARKER} output` }] } })
const owner = () => JSON.stringify({ type: 'session-owner', accountUuid: ACCOUNT, organizationUuid: 'oaoaoaoa-1111-4111-8111-111111111111' })
const logFile = (c, folder, session) => join(c.claude, 'projects', folder.replace(/[/.]/g, '-'), `${session}.jsonl`)

/** A git repository with an origin, a branch and the person's email. `commit` makes an empty commit at a time, by an email. */
function repo(folder, { origin, branch = 'main', email = 'me@example.com' } = {}) {
  mkdirSync(folder, { recursive: true })
  const g = (args, env = {}) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] })
  g(['init', '-q', '-b', branch])
  g(['config', 'user.email', email])
  g(['config', 'user.name', 'Me'])
  g(['config', 'commit.gpgsign', 'false'])
  if (origin) g(['remote', 'add', 'origin', origin])
  return {
    commit(ts, by = email) {
      const date = iso(ts)
      g(['commit', '-q', '--allow-empty', '-m', 'work'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_EMAIL: by, GIT_COMMITTER_EMAIL: by })
      return g(['rev-parse', 'HEAD']).trim()
    },
  }
}

/**
 * A stand-in for the board, on a free port of this computer. It keeps every request, with its body
 * unpacked. `poll` is the list of answers to the polls of a link, `ingest`, `me` and `logout` give
 * the answers to those requests.
 */
async function standIn({ poll = [], interval = 5, ingest, me, logout: out } = {}) {
  const seen = []
  let url
  const server = createServer(async (req, res) => {
    const parts = []
    for await (const part of req) parts.push(part)
    const sent = Buffer.concat(parts)
    const raw = req.headers['content-encoding'] === 'gzip' ? gunzipSync(sent) : sent
    const entry = { method: req.method, path: req.url, headers: req.headers, size: sent.length, text: raw.toString('utf8') }
    entry.body = entry.text ? JSON.parse(entry.text) : undefined
    seen.push(entry)
    let answer
    if (req.url === '/api/v1/device/start') answer = { status: 200, json: { device_code: 'dc-1', user_code: 'BCDF-GHJK', verification_uri: `${url}/device`, verification_uri_complete: `${url}/device?code=BCDF-GHJK`, expires_in: 900, interval } }
    else if (req.url === '/api/v1/device/poll') answer = poll.shift() ?? { status: 400, json: { error: 'expired_token' } }
    else if (req.url === '/api/v1/ingest') answer = ingest?.(entry, seen.filter((e) => e.path === req.url).length) ?? { status: 200, json: { ok: true, stored: {} } }
    else if (req.url === '/api/v1/me') answer = me?.(entry) ?? { status: 200, json: { machine: { id: 7, name: 'test-mac', lastSeenAt: Date.now() }, team: { login: 'Acme' }, user: { login: 'octo' } } }
    else if (req.url === '/api/v1/logout') answer = out?.(entry) ?? { status: 200, json: { ok: true } }
    else answer = { status: 404, json: { error: 'not found' } }
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer.json))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    seen,
    ingests: () => seen.filter((e) => e.path === '/api/v1/ingest'),
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(resolve)
    }),
  }
}

/** The answer of a poll that approves the link. */
const approved = { status: 200, json: { token: TOKEN, machine: { id: 7, name: 'test-mac' }, team: { login: 'Acme' }, user: { login: 'octo' } } }

/** Links the made-up computer to a board without the device flow: board.json as a login writes it. */
function link(url, fields = {}) {
  mkdirSync(process.env.KESTREL_HOME, { recursive: true })
  writeFileSync(join(process.env.KESTREL_HOME, 'board.json'), JSON.stringify({ url, token: TOKEN, machine: { id: 7, name: 'test-mac' }, team: 'Acme', user: 'octo', linkedAt: Date.now() - DAY, ...fields }))
}
const boardJson = () => JSON.parse(readFileSync(join(process.env.KESTREL_HOME, 'board.json'), 'utf8'))
/** Every call that the board got, over all its requests. */
const callsSent = (b) => b.ingests().flatMap((e) => e.body.calls ?? [])

/** Runs the command with the made-up computer's folders, and waits for it without blocking the stand-in. */
const run = (args, input = '') => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1' } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  child.on('close', (code) => resolve({ code, stdout, stderr }))
  child.stdin.end(input)
})

test('the board address: https:// is added, a slash at the end goes, and plain http:// only for this computer', () => {
  assert.equal(boardAddress('kestrel.widal.com'), 'https://kestrel.widal.com')
  assert.equal(boardAddress('https://kestrel.widal.com/'), 'https://kestrel.widal.com')
  assert.equal(boardAddress('http://localhost:8787/'), 'http://localhost:8787')
  assert.equal(boardAddress('http://127.0.0.1:9000'), 'http://127.0.0.1:9000')
  assert.throws(() => boardAddress('http://kestrel.widal.com'), /https:\/\//)
  assert.throws(() => boardAddress('http://192.168.1.5:8787'), /https:\/\//)
  assert.throws(() => boardAddress('https://me:secret@kestrel.widal.com'), /name or a password/)
  assert.throws(() => boardAddress('ftp://kestrel.widal.com'), /https:\/\//)
  assert.throws(() => boardAddress(''), /kestrel board login https:\/\/kestrel\.widal\.com/)
})

test('the GitHub name of a remote, in its usual forms, and none for another host', () => {
  assert.equal(githubName('https://github.com/Acme/widget.git'), 'Acme/widget')
  assert.equal(githubName('git@github.com:Acme/widget.git'), 'Acme/widget')
  assert.equal(githubName('ssh://git@github.com:22/Acme/widget'), 'Acme/widget')
  assert.equal(githubName('https://x-access-token:ghp_abc@github.com/Acme/widget'), 'Acme/widget')
  assert.equal(githubName('git@github-work:Acme/widget.git'), 'Acme/widget')
  assert.equal(githubName('https://gitlab.com/Acme/widget.git'), null)
  assert.equal(githubName('/srv/git/widget.git'), null)
  assert.equal(githubName('https://github.com/Acme'), null)
})

test('board login: prints the address and the code, polls every interval, slows down when told, saves board.json with mode 600, and runs the first sync', async () => {
  computer()
  const b = await standIn({ poll: [{ status: 428, json: { error: 'authorization_pending' } }, { status: 400, json: { error: 'slow_down' } }, approved] })
  const lines = []
  const waits = []
  const opened = []
  try {
    const first = await login(b.url, { out: (line) => lines.push(line), open: (page) => opened.push(page), sleep: async (ms) => waits.push(ms), name: 'test-mac' })
    // 5 seconds, 5 again after "pending", and 5 more after "slow down".
    assert.deepEqual(waits, [5000, 5000, 10000])
    const start = b.seen.find((e) => e.path === '/api/v1/device/start')
    assert.deepEqual(start.body, { name: 'test-mac', os: process.platform })
    assert.deepEqual(b.seen.filter((e) => e.path === '/api/v1/device/poll').map((e) => e.body), [{ device_code: 'dc-1' }, { device_code: 'dc-1' }, { device_code: 'dc-1' }])
    assert.deepEqual(opened, [`${b.url}/device?code=BCDF-GHJK`])
    assert.match(lines[0], new RegExp(`open ${b.url}/device and enter the code BCDF-GHJK`))

    const file = join(process.env.KESTREL_HOME, 'board.json')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const saved = boardJson()
    assert.deepEqual({ url: saved.url, token: saved.token, machine: saved.machine, team: saved.team, user: saved.user }, { url: b.url, token: TOKEN, machine: { id: 7, name: 'test-mac' }, team: 'Acme', user: 'octo' })
    assert.ok(Number.isFinite(saved.linkedAt))

    // The first sync ran, with the token, and the person is told what was sent.
    assert.equal(b.ingests().length, 1)
    assert.equal(b.ingests()[0].headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(first.requests, 1)
    assert.ok(lines.some((line) => line.startsWith(`Sent to ${b.url}: 0 model calls`)), lines.join('\n'))
    assert.ok(Number.isFinite(boardJson().lastSyncAt))
    // The token is never printed.
    assert.ok(!lines.join('\n').includes(TOKEN))
  } finally {
    await b.close()
  }
})

test('board login: a denied link and an expired code save nothing', async () => {
  computer()
  const quiet = { out: () => {}, open: () => {}, sleep: async () => {} }
  const denied = await standIn({ poll: [{ status: 400, json: { error: 'access_denied' } }] })
  await assert.rejects(login(denied.url, quiet), /denied on the board/)
  await denied.close()
  const expired = await standIn({ poll: [{ status: 428, json: { error: 'authorization_pending' } }, { status: 400, json: { error: 'expired_token' } }] })
  await assert.rejects(login(expired.url, quiet), /expired/)
  await expired.close()
  assert.equal(existsSync(join(process.env.KESTREL_HOME, 'board.json')), false)
  // An address on plain http:// that is not this computer is refused before anything is sent.
  await assert.rejects(login('http://kestrel.example.com', quiet), /https:\/\//)
})

test('a sync sends the calls, sessions, commits, findings, limits, accounts, settings and proposals in the board format, with ~ for the home folder and no text of a session', async () => {
  const c = computer()
  const now = Date.now()
  const t0 = now - 3 * HOUR
  const widget = join(c.home, 'work', 'widget')
  const r = repo(widget, { origin: 'git@github.com:Acme/widget.git', branch: 'user/abc-342-board' })
  const mine = r.commit(t0 + 20 * MIN)
  r.commit(t0 + 25 * MIN, 'colleague@example.com') // Came with a pull: not work of this computer.
  r.commit(now - 10 * HOUR) // No session ran then.
  const scratch = join(c.home, 'scratch')
  mkdirSync(scratch, { recursive: true })
  const at = { cwd: widget, branch: 'user/abc-342-board' }
  write(logFile(c, widget, 's1'), [
    owner(), prompt(t0), call('c1', t0, { ...at, tools: [['Bash']] }), result(t0 + 1000, 'c1-t0'),
    call('c2', t0 + 10 * MIN, at), call('c3', t0 + 30 * MIN, at),
  ])
  write(join(dirname(logFile(c, widget, 's1')), 's1', 'subagents', 'agent-x1.jsonl'), [call('c4', t0 + 15 * MIN, at)])
  writeFileSync(join(dirname(logFile(c, widget, 's1')), 's1', 'subagents', 'agent-x1.meta.json'), JSON.stringify({ agentType: 'Explore' }))
  write(logFile(c, scratch, 's2'), [owner(), prompt(now - HOUR), call('c5', now - HOUR, { cwd: scratch })])
  mkdirSync(c.kestrel, { recursive: true })
  writeFileSync(join(c.kestrel, 'findings.json'), JSON.stringify({ at: now, findings: [{
    id: `code.secret:${widget}:a.txt:1`, rule: 'code.secret', kind: 'code', severity: 'high', title: 'A secret in a file',
    where: { repo: widget, file: 'a.txt', line: 1 }, scope: `repo:${widget}`, controls: [], fix: null, source: 'kestrel', status: 'open', firstSeen: now - HOUR, lastSeen: now,
  }] }))
  const reading = { pct: 13, resetsAt: now + 2 * HOUR, at: now - MIN }
  writeFileSync(join(c.kestrel, 'limits.json'), JSON.stringify({ [`claude:${ACCOUNT}`]: { five: reading } }))

  const b = await standIn()
  link(b.url)
  try {
    const sent = await sync({ now })
    assert.equal(b.ingests().length, 1)
    const e = b.ingests()[0]
    assert.equal(e.headers['content-encoding'], 'gzip')
    assert.equal(e.headers['content-type'], 'application/json')
    assert.equal(e.headers.authorization, `Bearer ${TOKEN}`)
    const body = e.body
    assert.equal(body.v, 1)
    assert.deepEqual(body.machine, { os: process.platform, kestrel: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, names: true })

    // No text of a session, and not the home folder with the user name.
    assert.ok(!e.text.includes(MARKER))
    assert.ok(!e.text.includes(c.home) && !e.text.includes(realpathSync(c.home)))

    const byId = Object.fromEntries(body.calls.map((x) => [x.id, x]))
    assert.deepEqual(Object.keys(byId).sort(), ['c1', 'c2', 'c3', 'c4', 'c5'])
    assert.deepEqual(byId.c1, {
      id: 'c1', ts: t0, session: 's1', source: 'claude', model: 'claude-opus-5-5', effort: null,
      in: 1000, w5: 0, w1: 0, cr: 0, out: 100, th: 0, web: 0, cost: 0.006,
      folder: '~/work/widget', repo: 'Acme/widget', branch: 'user/abc-342-board', ticket: 'ABC-342',
      account: `claude:${ACCOUNT}`, subagent: false, parent: null,
      tools: [['Bash', byId.c1.tools[0][1]]], added: [['(your messages)', `Please fix ${MARKER}`.length]], err: 0, intr: 0,
    })
    assert.match(byId.c1.tools[0][1], /^[0-9a-f]{8}$/)
    // The tool's result entered before the second call: its size, never its text.
    assert.deepEqual(byId.c2.added, [['Bash', `${MARKER} output`.length]])
    // The subagent's call is a session of its own, with its parent.
    assert.deepEqual([byId.c4.session, byId.c4.subagent, byId.c4.parent, byId.c4.account], ['s1:agent-x1', true, 's1', `claude:${ACCOUNT}`])
    // A folder that is no git repository: no repository, no branch, no ticket.
    assert.deepEqual([byId.c5.folder, byId.c5.repo, byId.c5.branch, byId.c5.ticket], ['~/scratch', null, null, null])

    const sessions = Object.fromEntries(body.sessions.map((s) => [s.id, s]))
    assert.deepEqual(sessions.s1, { id: 's1', source: 'claude', parent: null, kind: null, folder: '~/work/widget', repo: 'Acme/widget', branch: 'user/abc-342-board', ticket: 'ABC-342', state: null })
    assert.deepEqual([sessions['s1:agent-x1'].parent, sessions['s1:agent-x1'].kind], ['s1', 'Explore'])
    assert.equal(sessions.s2.folder, '~/scratch')

    // One commit: the person's own, made while s1 worked. Not the colleague's, and not the one without a session.
    assert.deepEqual(body.commits, [{ repo: 'Acme/widget', sha: mine, ts: Math.floor((t0 + 20 * MIN) / 1000) * 1000, session: 's1' }])

    assert.equal(body.findings.at, now)
    assert.equal(body.findings.items.length, 1)
    const f = body.findings.items[0]
    assert.deepEqual([f.id, f.where.repo, f.scope, f.severity, f.kind, f.status], ['code.secret:~/work/widget:a.txt:1', '~/work/widget', 'repo:~/work/widget', 'high', 'code', 'open'])
    assert.deepEqual(body.limits, { [`claude:${ACCOUNT}`]: { five: reading } })
    assert.deepEqual(body.accounts, [{ key: `claude:${ACCOUNT}`, label: 'claude:aaaaaaaa', billing: 'subscription', tier: null, price: null }])
    assert.ok(Array.isArray(body.settings.settings) && body.settings.settings.some((s) => s.key === 'hud.names'))
    assert.equal(body.proposals.days, 30)

    // What was sent is saved, with the cursor, only now that the board took it.
    assert.deepEqual(sent, { calls: 5, sessions: 3, commits: 1, findings: 1, accounts: 1, proposals: true, requests: 1 })
    const saved = boardJson()
    assert.equal(saved.cursor, now)
    assert.deepEqual(saved.lastSent, sent)
    assert.equal(saved.proposalsAt, now)
    assert.equal(statSync(join(c.kestrel, 'board.json')).mode & 0o777, 0o600)
  } finally {
    await b.close()
  }
})

test('each account sent to the board has the price of its plan: the person\'s own, else a public price that Kestrel knows, else null', async () => {
  const c = computer()
  const now = Date.now()
  const B = 'bbbbbbbb-2222-4222-8222-222222222222'
  const C = 'cccccccc-3333-4333-8333-333333333333'
  mkdirSync(c.kestrel, { recursive: true })
  // A: Claude Max, with no price of the person's own. B: a Team seat, priced by the person. C: a
  // Team seat without a price. Cowork with A's id shares A's plan. Codex on ChatGPT Plus.
  writeFileSync(join(c.kestrel, 'accounts.json'), JSON.stringify({
    accounts: {
      [`claude:${ACCOUNT}`]: { organizationType: 'claude_max', billingType: 'stripe_subscription' },
      [`claude:${B}`]: { organizationType: 'claude_team', seatTier: 'team_tier_1', price: 30 },
      [`claude:${C}`]: { organizationType: 'claude_team', seatTier: 'team_tier_1' },
      [`cowork:${ACCOUNT}`]: {},
      'codex:plus': {},
      api: {},
    },
    signedIn: {},
  }))
  const b = await standIn()
  link(b.url)
  try {
    await sync({ now })
    const byKey = Object.fromEntries(b.ingests()[0].body.accounts.map((a) => [a.key, a]))
    assert.deepEqual(byKey[`claude:${ACCOUNT}`].price, { monthly: 100, source: 'table' })
    assert.deepEqual(byKey[`cowork:${ACCOUNT}`].price, { monthly: 100, source: 'table' })
    assert.deepEqual(byKey[`claude:${B}`].price, { monthly: 30, source: 'set' })
    assert.equal(byKey[`claude:${C}`].price, null)
    assert.deepEqual(byKey['codex:plus'].price, { monthly: 20, source: 'table' })
    assert.equal(byKey.api.price, null)
    for (const a of Object.values(byKey)) assert.deepEqual(Object.keys(a), ['key', 'label', 'billing', 'tier', 'price'])
  } finally {
    await b.close()
  }
})

test('the calls go 2000 to a request, and a body over the size is split in half until it fits', async () => {
  const c = computer()
  const now = Date.now()
  const big = join(c.home, 'big')
  const lines = [owner()]
  for (let i = 0; i < 4500; i++) lines.push(call(`m${i}`, now - 4 * HOUR + i * 1000, { cwd: big }))
  write(logFile(c, big, 'many'), lines)

  const b = await standIn()
  link(b.url)
  try {
    await sync({ now })
    assert.deepEqual(b.ingests().map((e) => e.body.calls?.length ?? 0), [2000, 2000, 500])
    // The other parts ride along with the last calls.
    assert.ok(b.ingests()[2].body.sessions && b.ingests()[2].body.findings && b.ingests()[2].body.settings)
    assert.equal(new Set(callsSent(b).map((x) => x.id)).size, 4500)
    // Every request carries the machine, so that the board always knows whether names are on.
    assert.ok(b.ingests().every((e) => e.body.v === 1 && e.body.machine?.names === true))
  } finally {
    await b.close()
  }

  // With a smaller size, a request of 2000 calls is split in halves, and each part goes once.
  const small = await standIn()
  link(small.url)
  try {
    // 2000 of these calls pack to about 12 KB.
    const maxBody = 5_000
    await sync({ now, maxBody })
    const list = small.ingests()
    assert.ok(list.length > 6, `${list.length} requests`)
    const withCalls = list.filter((e) => e.body.calls)
    assert.ok(withCalls.length > 3 && withCalls.every((e) => e.size <= maxBody), withCalls.map((e) => e.size).join(', '))
    assert.ok(list.every((e) => (e.body.calls?.length ?? 0) <= 2000))
    assert.equal(callsSent(small).length, 4500)
    assert.equal(new Set(callsSent(small).map((x) => x.id)).size, 4500)
    for (const part of ['findings', 'limits', 'accounts', 'settings']) assert.equal(list.filter((e) => e.body[part] !== undefined).length, 1, part)
  } finally {
    await small.close()
  }
})

test('bodies: parts that would push a body over the size go in a request of their own', () => {
  const machine = { os: 'darwin', kestrel: '0.1.0', names: true }
  // Text that does not pack well, so that its size stays: 50,000 characters pack to about 33 KB.
  let seed = 1
  const noise = (n) => Array.from({ length: n }, () => ((seed = (seed * 48271) % 2147483647) % 36).toString(36)).join('')
  const payload = { machine, calls: [{ id: 'a' }], sessions: [], commits: [], findings: { at: 1, items: [] }, settings: { blob: noise(50_000) }, limits: {}, accounts: [], proposals: { blob: noise(50_000) } }
  const list = bodies(payload, { maxBody: 40_000 }).map((b) => JSON.parse(gunzipSync(b)))
  assert.ok(list.length >= 2)
  assert.equal(list.filter((b) => b.settings).length, 1)
  assert.equal(list.filter((b) => b.proposals).length, 1)
  assert.ok(!list.some((b) => b.settings && b.proposals))
  assert.ok(list.every((b) => b.v === 1 && b.machine.names === true))
})

test('with names off, no tasks and no agents are sent, and machine.names says so; with names on, an open session has its tasks and agents', async () => {
  const c = computer()
  const now = Date.now()
  const work = join(c.home, 'work', 'x')
  mkdirSync(work, { recursive: true })
  const todos = { todos: [{ content: 'Read the code', status: 'completed' }, { content: 'Write the tests', activeForm: 'Writing the tests', status: 'in_progress' }] }
  write(logFile(c, work, 'live1'), [
    owner(), prompt(now - 10 * MIN),
    call('l1', now - 10 * MIN, { cwd: work, tools: [['TodoWrite', todos], ['Agent', { subagent_type: 'Explore', description: 'Look around' }]] }),
  ])
  // The file that the status line keeps for an open session: it ran 10 seconds ago, after a model call.
  mkdirSync(join(c.kestrel, 'sessions'), { recursive: true })
  writeFileSync(join(c.kestrel, 'sessions', 'live1.json'), JSON.stringify({ at: now - 10e3, callAt: now - 5e3, project: 'work/x' }))

  const b = await standIn()
  link(b.url)
  try {
    await sync({ now })
    const on = b.ingests()[0].body
    assert.equal(on.machine.names, true)
    const s = on.sessions.find((x) => x.id === 'live1')
    assert.equal(s.state, 'working')
    assert.deepEqual(s.tasks, [{ name: 'Read the code', done: true }, { name: 'Writing the tests', done: false }])
    assert.deepEqual(s.agents.map((a) => [a.kind, a.what]), [['Explore', 'Look around']])

    saveConfig({ hud: { names: false } })
    await sync({ now: now + 1000 })
    const off = b.ingests()[1]
    assert.equal(off.body.machine.names, false)
    assert.equal(off.body.sessions.find((x) => x.id === 'live1').state, 'working')
    assert.ok(off.body.sessions.every((x) => !('tasks' in x) && !('agents' in x)))
    assert.ok(!off.text.includes('Writing the tests') && !off.text.includes('Look around'))
  } finally {
    await b.close()
  }
})

test('the cursor: the first sync sends 30 days, the next one from an hour before the last; nothing is saved when the board fails', async () => {
  const c = computer()
  const now = Date.now()
  const work = join(c.home, 'w')
  write(logFile(c, work, 'old-and-new'), [owner(), call('old', now - 3 * DAY, { cwd: work }), call('new', now - 30 * MIN, { cwd: work })])
  let fail = false
  const b = await standIn({ ingest: (e, n) => (fail && n === 2 ? { status: 500, json: { error: 'down' } } : undefined) })
  link(b.url)
  try {
    await sync({ now })
    assert.deepEqual(callsSent(b).map((x) => x.id), ['old', 'new'])
    const first = boardJson()
    assert.equal(first.cursor, now)
    assert.equal(first.lastSent.calls, 2)

    // From one hour before the last sync: the call of 3 days ago is not sent again.
    await sync({ now: now + MIN })
    assert.deepEqual(b.ingests()[1].body.calls.map((x) => x.id), ['new'])
    // --days sends that many days.
    await sync({ now: now + 2 * MIN, days: 5 })
    assert.deepEqual(b.ingests()[2].body.calls.map((x) => x.id), ['old', 'new'])
    const before = boardJson()

    // The board takes the first request and fails on the second: nothing is saved.
    b.ingests().length = 0
    b.seen.length = 0
    fail = true
    await assert.rejects(sync({ now: now + 3 * MIN, days: 5, maxCalls: 1 }), /answered 500: down/)
    const after = boardJson()
    assert.deepEqual([after.cursor, after.lastSyncAt, after.lastSent], [before.cursor, before.lastSyncAt, before.lastSent])
    assert.match(after.lastTry.error, /500/)
  } finally {
    await b.close()
  }
  // The board cannot be reached: nothing is saved either, and the next sync tries again.
  const before = boardJson()
  await assert.rejects(sync({ now: now + 4 * MIN }), /Could not reach the board/)
  const after = boardJson()
  assert.deepEqual([after.cursor, after.lastSyncAt, after.lastSent], [before.cursor, before.lastSyncAt, before.lastSent])
  assert.equal(after.stopped, undefined)
  assert.equal(syncDue(now + 30 * MIN), true)
})

test('a refused token (401) turns background sync off and says to link again', async () => {
  computer()
  const b = await standIn({ ingest: () => ({ status: 401, json: { error: 'This machine token is not known to the board.' } }), me: () => ({ status: 403, json: { error: 'removed' } }) })
  link(b.url, { lastSyncAt: Date.now() - HOUR })
  try {
    await assert.rejects(sync(), /kestrel board login/)
    assert.equal(boardJson().stopped.status, 401)
    const spawned = []
    assert.equal(startBoardSync(Date.now(), (...args) => spawned.push(args)), false)
    assert.equal(spawned.length, 0)
    const text = await status()
    assert.match(text, /Background sync +off/)
    assert.match(text, /the board removed this computer/)
  } finally {
    await b.close()
  }
})

test('board logout tells the board and deletes board.json, also when the board cannot be reached', async () => {
  computer()
  const b = await standIn()
  link(b.url)
  try {
    assert.match(await logout(), /removed this computer/)
    const told = b.seen.find((e) => e.path === '/api/v1/logout')
    assert.equal(told.method, 'POST')
    assert.equal(told.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(existsSync(join(process.env.KESTREL_HOME, 'board.json')), false)
    assert.equal(readBoard(), undefined)
  } finally {
    await b.close()
  }
  // A board that is gone: the link on this computer is deleted all the same.
  link(b.url)
  assert.match(await logout(), /could not be told/)
  assert.equal(existsSync(join(process.env.KESTREL_HOME, 'board.json')), false)
  assert.match(await logout(), /not linked/)
})

test('the background start: at most every 10 minutes, never while a sync holds the lock, and from the status line', async () => {
  computer()
  const now = Date.now()
  const spawned = []
  const spawner = (...args) => {
    spawned.push(args)
    return { unref() {} }
  }
  assert.equal(startBoardSync(now, spawner), false) // Not linked.
  link('https://kestrel.widal.com', { lastSyncAt: now - 5 * MIN })
  assert.equal(startBoardSync(now, spawner), false) // The last sync is 5 minutes old.
  link('https://kestrel.widal.com', { lastSyncAt: now - 11 * MIN })
  assert.equal(startBoardSync(now, spawner), true)
  assert.deepEqual(spawned[0][1].slice(1), ['board', 'sync', '--quiet'])
  assert.equal(spawned[0][1][0], BIN)
  assert.deepEqual(spawned[0][2], { detached: true, stdio: 'ignore' })
  // A sync that failed is not started again on every run: the next start is 10 minutes later.
  assert.equal(startBoardSync(now + MIN, spawner), false)
  assert.equal(startBoardSync(now + 11 * MIN, spawner), true)

  // A lock held by a running sync stops a start. A lock older than 10 minutes does not.
  computer()
  link('https://kestrel.widal.com', { lastSyncAt: now - HOUR })
  const lock = join(process.env.KESTREL_HOME, 'board.lock')
  writeFileSync(lock, JSON.stringify({ pid: 1, at: now - 2 * MIN }))
  assert.equal(startBoardSync(now, spawner), false)
  writeFileSync(lock, JSON.stringify({ pid: 1, at: now - 11 * MIN }))
  assert.equal(startBoardSync(now, spawner), true)

  // The status line starts it, in both layouts, and never waits for it.
  computer()
  link('https://kestrel.widal.com', { lastSyncAt: now - HOUR })
  spawned.length = 0
  statusLine({ session_id: 'one', cwd: '/work/app', model: { id: 'claude-opus-5-5' } }, now, { env: {}, color: false, layout: 'one', notify: () => {}, spawn: spawner })
  assert.deepEqual(spawned.map((args) => args[1].slice(1)), [['board', 'sync', '--quiet']])
})

test('a sync waits for no lock: while another sync holds it, nothing is sent; a stale lock is taken over and taken away after', async () => {
  computer()
  const b = await standIn()
  link(b.url)
  const lock = join(process.env.KESTREL_HOME, 'board.lock')
  try {
    writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() }))
    assert.deepEqual(await sync(), { busy: true })
    assert.equal(b.ingests().length, 0)
    assert.equal(existsSync(lock), true)
    writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() - 11 * MIN }))
    const sent = await sync()
    assert.equal(sent.requests, 1)
    assert.equal(existsSync(lock), false)
  } finally {
    await b.close()
  }
})

test('the hook at the end of a turn starts the background sync when it is due', async () => {
  computer()
  // A board that is not there: the sync that starts fails at once, and harms nothing.
  const gone = await standIn()
  await gone.close()
  link(gone.url, { lastSyncAt: Date.now() - HOUR })
  const r = await run(['hook', 'check-turn', '--plugin'], '{}')
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
  assert.ok(existsSync(join(process.env.KESTREL_HOME, 'board.start')))
})

test('the commands: login, status and logout through kestrel, and the board in the help', async () => {
  computer()
  const b = await standIn({ interval: 1, poll: [approved] })
  try {
    const login = await run(['board', 'login', b.url])
    assert.equal(login.code, 0, login.stderr)
    assert.match(login.stdout, /enter the code BCDF-GHJK/)
    assert.match(login.stdout, /Linked this computer \(test-mac\) to the team Acme/)
    assert.match(login.stdout, /Sent to http:\/\/127\.0\.0\.1:\d+: /)
    assert.ok(!login.stdout.includes(TOKEN))
    assert.equal(statSync(join(process.env.KESTREL_HOME, 'board.json')).mode & 0o777, 0o600)

    const shown = await run(['board', 'status'])
    assert.equal(shown.code, 0, shown.stderr)
    assert.match(shown.stdout, /Team +Acme/)
    assert.match(shown.stdout, new RegExp(`Token +kbm_…${TOKEN.slice(-4)}`))
    assert.match(shown.stdout, /the board knows this computer/)
    assert.match(shown.stdout, /Background sync +on/)
    assert.ok(!shown.stdout.includes(TOKEN))
    assert.match((await run(['status'])).stdout, /Kestrel board +linked to http:\/\/127\.0\.0\.1:\d+ \(Acme\), last sync/)

    const days = await run(['board', 'sync', '--days', '0'])
    assert.equal(days.code, 1)
    assert.match(days.stderr, /--days is a whole number of days/)
    const quiet = await run(['board', 'sync', '--quiet'])
    assert.deepEqual([quiet.code, quiet.stdout, quiet.stderr], [0, '', ''])

    const out = await run(['board', 'logout'])
    assert.match(out.stdout, /removed this computer/)
    assert.equal(existsSync(join(process.env.KESTREL_HOME, 'board.json')), false)
  } finally {
    await b.close()
  }
  const plain = await run(['board', 'login', 'http://kestrel.example.com'])
  assert.equal(plain.code, 1)
  assert.match(plain.stderr, /must use https:\/\//)
  const help = await run(['--help'])
  assert.match(help.stdout, /kestrel board login https:\/\/kestrel\.widal\.com/)
  assert.match((await run(['board'])).stdout, /kestrel board logout/)
})
