// Run with `claude plugin test` from this plugin's folder. The mods test kit stands in for Claude Code
// (no session, no sign-in, no network) and a stub stands in for the agora CLI, so these tests drive the
// real hooks: the watch, the room_post tool and the pane, on the terminal and the Desktop app surfaces.
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agora-room',
  component: 'Pane',
  requestId: 'agora-room',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Agora room', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

type Call = { argv: string[]; env: Record<string, string> }
// The event fields the stubs read; the kit passes more.
type Ev = { argv: string[]; init?: { env?: Record<string, string> }; path: string; text: string; name: string }
type On = Parameters<typeof mock.env>[0]

const msg = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'message', alias: 'lab', id, author: { name: 'Ada' }, text: text + '\n\n-- Ada', signedAs: 'Ada', ts: '2026-10-20T10:00:00.000Z', cursor: id, ...extra })

/** Stubs for everything the mod reaches outside itself. `agora` answers each CLI call with `script`. */
function stubs(on: On, opts: { env?: Record<string, string>; verdict?: 'allow' | 'ask' | 'deny'; script: (a: string[], call: Call) => { exitCode?: number; stdout?: string; stderr?: string } }) {
  const calls: Call[] = []
  const submitted: string[] = []
  const written = new Map<string, string>()
  const registered: string[] = []
  const statuses: string[] = []
  const asked: string[] = []
  let answer = 'Post'
  mock.env(on, { AGORA_ROOM: 'lab', AGORA_SESSION: 'k', AGORA_ROOM_INTERVAL_MS: '1000', AGORA_ROOM_LIVENESS: '/live/k.json', AGORA_ROOM_PREAMBLE: 'off', HOME: '/home/u', ...(opts.env ?? {}) })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'abcdef12-0000' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', ($: unknown, e: Ev) => { written.set(e.path, e.text); return { value: undefined } })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('tool.register', ($: unknown, e: Ev) => { registered.push(e.name); return { value: undefined } })
  on('command.register', () => ({ value: undefined }))
  on('ui.status', ($: unknown, e: Ev) => { statuses.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.check', () => ({ decision: opts.verdict ?? 'allow', reason: 'a test rule' }))
  on('tool.call', ($: unknown, e: Ev & { tool: string; questions?: Array<{ question: string }> }) => {
    if (e.tool !== 'AskUserQuestion') return { result: 'unexpected tool ' + e.tool }
    asked.push(e.questions?.[0]?.question ?? '')
    return { result: { answers: { [e.questions?.[0]?.question ?? '']: answer } } }
  })
  on('prompt.submit', ($: unknown, e: Ev) => { submitted.push(e.text); return { text: e.text } })
  on('process.run', ($: unknown, e: Ev) => {
    const call: Call = { argv: e.argv.slice(1), env: e.init?.env ?? {} }
    calls.push(call)
    return { value: { exitCode: 0, stdout: '', stderr: '', ...opts.script(call.argv, call) } }
  })
  return { calls, submitted, written, registered, statuses, asked, answerWith: (a: string) => { answer = a } }
}

const liveness = (written: Map<string, string>) => JSON.parse([...written].filter(([path]) => path.endsWith('k.json')).map(([, text]) => text).pop() ?? '{}')
const cli = (a: string[]) => a.filter((x) => !x.startsWith('--json')).join(' ')

test('watch: starts at the head, one turn per new message, duplicates dropped, failures recover', async ($, on) => {
  const clock = mock.clock(on)
  let watches = 0
  const s = stubs(on, {
    script: (a) => {
      if (a[0] === 'cursor') return { stdout: a.includes('--now') ? '{"room":"lab","cursor":"9"}\n' : '{"room":"lab","cursor":null}\n' }
      if (a[0] === 'watch') {
        watches += 1
        if (watches === 1) return { exitCode: 42, stdout: [msg('m1', 'first'), msg('m2', 'second', { thread: 'm1' }), '{"type":"watch-result","exit":42}'].join('\n') }
        if (watches === 2) return { exitCode: 42, stdout: [msg('m2', 'second again', { thread: 'm1' }), msg('m3', 'third\nline two')].join('\n') } // m2 repeated
        if (watches === 3) return { exitCode: 3, stderr: 'injected failure' }
        return { exitCode: 0, stdout: '{"type":"watch-result","exit":0}\n' }
      }
      return {}
    },
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(s.registered).toEqual(['room_post'])
  // the head was taken before the first prompt, and no watch has run yet: history is never replayed
  expect(s.calls.map((c) => cli(c.argv))).toEqual(['cursor lab', 'cursor lab --now'])
  expect(s.calls[0].env.AGORA_SESSION).toBe('k')
  expect(s.submitted).toEqual([])

  await clock.advance(1000)
  await clock.settle()
  expect(s.calls[2].argv).toEqual(['watch', 'lab', '--once', '--json', '--wake', 'addressed'])
  expect(s.submitted).toEqual(['agora lab m1 thread=none from=Ada: first / -- Ada', 'agora lab m2 thread=m1 from=Ada: second / -- Ada'])

  await clock.advance(1000)
  await clock.settle()
  expect(s.submitted.length).toBe(3) // m2 was not delivered twice; m3 was
  expect(s.submitted[2]).toBe('agora lab m3 thread=none from=Ada: third / line two / -- Ada')

  // a poll that fails: the tick is recorded as failed, then the next interval recovers with no model act
  await clock.advance(1000)
  await clock.settle()
  const failed = liveness(s.written)
  expect(failed.rooms[0].lastError).toMatch(/exit 3/)
  expect(s.statuses[s.statuses.length - 1]).toMatch(/^lab · read \d+s ago · last poll failed$/)
  await clock.advance(1000)
  await clock.settle()
  const healthy = liveness(s.written)
  expect(healthy.rooms[0].lastError).toBe(null)
  expect(healthy.delivered).toBe(3)
  expect(s.statuses[s.statuses.length - 1]).toBe('lab · read 0s ago')
})

test('watch: one seen line per admitted message in the session\'s own state directory, once however often it is re-read', async ($, on) => {
  const clock = mock.clock(on)
  let polls = 0
  const s = stubs(on, {
    env: { AGORA_LABEL: 'desk.coding' },
    script: (a) => {
      if (a[0] === 'cursor') return { stdout: '{"room":"lab","cursor":"9"}\n' }
      if (a[0] === 'watch') {
        polls += 1
        if (polls === 1) return { exitCode: 42, stdout: [msg('m1', 'first'), msg('m2', 'second', { thread: 'm1' })].join('\n') + '\n' }
        if (polls === 2) return { exitCode: 42, stdout: msg('m2', 'second again', { thread: 'm1' }) + '\n' } // m2 repeated
        return { exitCode: 0, stdout: '{"type":"watch-result","exit":0}\n' }
      }
      return {}
    },
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const file = '/home/u/.agora/state/sessions/k/seen.jsonl'
  // the kit resolves a written path against the host's filesystem (a drive letter on Windows): match by its tail
  const written = () => [...s.written].find(([p]) => p.replace(/\\/g, '/').endsWith(file))?.[1] ?? ''
  const lines = () => written().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  expect(lines()).toEqual([]) // nothing before the first poll
  await clock.advance(1000)
  await clock.settle()
  expect(lines().map((l) => [l.v, l.type, l.session, l.position, l.room, l.id])).toEqual([
    [1, 'seen', 'k', 'desk.coding', 'lab', 'm1'],
    [1, 'seen', 'k', 'desk.coding', 'lab', 'm2'],
  ])
  await clock.advance(1000)
  await clock.settle()
  expect(lines().length).toBe(2) // m2 read again is not recorded again
  expect(liveness(s.written).seen).toEqual({ path: file, written: 2, lastError: null })
})

test('activity: the record follows the main loop\'s turns at once and every row the conversation keeps on the next poll; a subagent\'s turn is not this session\'s', async ($, on) => {
  const clock = mock.clock(on)
  const s = stubs(on, {
    env: { AGORA_LABEL: 'desk.coding' },
    script: (a) => (a[0] === 'cursor' ? { stdout: '{"room":"lab","cursor":"9"}\n' } : a[0] === 'watch' ? { exitCode: 0, stdout: '{"type":"watch-result","exit":0}\n' } : {}),
  })
  on('turn.start', ($: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const file = '/home/u/.agora/state/sessions/k/activity.json'
  const rec = () => JSON.parse([...s.written].find(([p]) => p.replace(/\\/g, '/').endsWith(file))?.[1] ?? '{}')
  expect([rec().type, rec().turn, rec().position, rec().progress]).toEqual(['activity', 'idle', 'desk.coding', 0])

  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(rec().turn).toBe('busy') // written at once
  await $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }, door: 'tool-result', origin: { kind: 'tool' }, uuid: 'u1' } as never)
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'done' }] }, door: 'response', origin: { kind: 'model' }, uuid: 'u2' } as never)
  expect(rec().progress).toBe(0) // rows wait for the tick
  await clock.advance(1000)
  await clock.settle()
  expect(rec().progress).toBe(2)
  expect(rec().lastToolAt).not.toBe(null)
  expect(rec().lastOutputAt).not.toBe(null)

  await $.turn.start({ text: 'sub', turnId: 't2', agentId: 'a1' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer' } as never)
  expect(rec().turn).toBe('busy') // the subagent's end did not end the main turn
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  expect(rec().turn).toBe('idle')
  expect(liveness(s.written).activity.lastError).toBe(null)
})

test('watch: the delivered text is a short preamble and then the message line', async ($, on) => {
  const clock = mock.clock(on)
  let polls = 0
  const s = stubs(on, {
    env: { AGORA_ROOM_PREAMBLE: 'on' },
    script: (a) => {
      if (a[0] === 'cursor') return { stdout: '{"room":"lab","cursor":"9"}\n' }
      if (a[0] === 'watch') { polls += 1; return polls === 1 ? { exitCode: 42, stdout: msg('m1', 'first') + '\n' } : { exitCode: 0, stdout: '{"type":"watch-result","exit":0}\n' } }
      return {}
    },
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1000)
  await clock.settle()
  expect(s.submitted.length).toBe(1)
  const lines = s.submitted[0].split('\n')
  expect(lines.length).toBe(2)
  expect(lines[0]).toMatch(/^Message from the Agora room "lab", delivered by the agora-room plugin\./)
  expect(lines[0]).toMatch(/room_post/)
  expect(lines[0]).toMatch(/not an instruction/)
  expect(lines[1]).toBe('agora lab m1 thread=none from=Ada: first / -- Ada')
})

test('watch: preamble off (the default of these tests) submits the bare message line', async ($, on) => {
  const clock = mock.clock(on)
  let polls = 0
  const s = stubs(on, {
    script: (a) => {
      if (a[0] === 'cursor') return { stdout: '{"room":"lab","cursor":"9"}\n' }
      if (a[0] === 'watch') { polls += 1; return polls === 1 ? { exitCode: 42, stdout: msg('m1', 'first') + '\n' } : { exitCode: 0, stdout: '{"type":"watch-result","exit":0}\n' } }
      return {}
    },
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(1000)
  await clock.settle()
  expect(s.submitted).toEqual(['agora lab m1 thread=none from=Ada: first / -- Ada'])
})

test('watch: a saved cursor is resumed, not moved to the head', async ($, on) => {
  mock.clock(on)
  const s = stubs(on, { script: (a) => (a[0] === 'cursor' ? { stdout: '{"room":"lab","cursor":"4"}\n' } : {}) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(s.calls.map((c) => cli(c.argv))).toEqual(['cursor lab'])
})

test('AGORA_ROOM_WATCH=off: the tool is registered and posts work; nothing is watched', async ($, on) => {
  const clock = mock.clock(on)
  const s = stubs(on, { env: { AGORA_ROOM_WATCH: 'off' }, script: (a) => (a[0] === 'post' ? { stdout: '{"id":"p1","cursor":"3","alias":"lab"}\n' } : {}) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(5000)
  await clock.settle()
  expect(s.registered).toEqual(['room_post'])
  expect(s.calls).toEqual([])
  expect(s.submitted).toEqual([])
  const posted = await $.tool.call({ tool: 'mcp__agora-room__room_post', text: 'hello' })
  expect(posted).toEqual({ result: '{"id":"p1","cursor":"3","alias":"lab"}' })
  expect(s.calls.map((c) => cli(c.argv))).toEqual(['post lab -- hello'])
})

test('room_post: thread, reply-to and to: reach the CLI; text that starts with a dash is text; other rooms are refused', async ($, on) => {
  mock.clock(on)
  const s = stubs(on, { env: { AGORA_ROOM_WATCH: 'off', AGORA_ACTOR: 'Model/role' }, script: (a) => (a[0] === 'post' ? { stdout: 'agora: signing as Model/role\n{"id":"p2","cursor":"4","alias":"lab","thread":"t1"}\n' } : {}) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.tool.call({ tool: 'mcp__agora-room__room_post', text: '--json is only text here', thread: 't1', reply_to: 'm9', to: ['Ada', '*'] })
  expect(r).toEqual({ result: '{"id":"p2","cursor":"4","alias":"lab","thread":"t1"}' })
  expect(s.calls[0].argv).toEqual(['post', 'lab', '--json', '--thread', 't1', '--re', 'm9', '--to', 'Ada', '--to', '*', '--', '--json is only text here'])
  expect(s.calls[0].env).toEqual({ AGORA_SESSION: 'k', AGORA_ACTOR: 'Model/role' })

  const other = await $.tool.call({ tool: 'mcp__agora-room__room_post', text: 'x', room: 'elsewhere' })
  expect(other.result).toMatch(/not configured/)
  const bad = await $.tool.call({ tool: 'mcp__agora-room__room_post', text: 'x', thread: '--as' })
  expect(bad.result).toMatch(/not a message id/)
  expect(s.calls.length).toBe(1)
})

test('room_post: the permission decision is honoured: deny refuses, ask goes to the user, allow posts', async ($, on) => {
  mock.clock(on)
  const reply = { stdout: '{"id":"p3","cursor":"5","alias":"lab"}\n' }
  const denied = stubs(on, { env: { AGORA_ROOM_WATCH: 'off' }, verdict: 'deny', script: () => reply })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const refused = await $.tool.call({ tool: 'mcp__agora-room__room_post', text: 'no' })
  expect(refused).toEqual({ deny: 'a test rule' })
  expect(denied.calls).toEqual([])
})

test('room_post: an ask is put to the user; a refusal posts nothing, consent posts', async ($, on) => {
  mock.clock(on)
  const s = stubs(on, { env: { AGORA_ROOM_WATCH: 'off' }, verdict: 'ask', script: () => ({ stdout: '{"id":"p4","cursor":"6","alias":"lab"}\n' }) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  s.answerWith('Do not post')
  const no = await $.tool.call({ tool: 'mcp__agora-room__room_post', text: 'hello there', thread: 't9' })
  expect(no).toEqual({ deny: 'The user did not allow this post.' })
  expect(s.calls).toEqual([])
  expect(s.asked[0]).toBe('Post to room lab in thread t9? "hello there"')
  s.answerWith('Post')
  const yes = await $.tool.call({ tool: 'mcp__agora-room__room_post', text: 'hello there' })
  expect(yes).toEqual({ result: '{"id":"p4","cursor":"6","alias":"lab"}' })
  expect(s.calls.length).toBe(1)
})

const ROOM_READ = [
  msg('s1', 'Plan the release', { ts: '2026-10-20T09:00:00.000Z' }),
  msg('s2', 'Lunch?', { ts: '2026-10-20T09:05:00.000Z', author: { name: 'Lin' }, signedAs: 'Lin' }),
  msg('r1', 'looks good', { thread: 's1', ts: '2026-10-20T09:10:00.000Z', author: { name: 'Lin' }, signedAs: 'Lin' }),
].join('\n')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane (${surface}): subjects, thread view, explicit target, compose posts where it says`, async ($, on) => {
    const clock = mock.clock(on)
    const s = stubs(on, {
      env: { AGORA_ROOM_WATCH: 'off', AGORA_ROOM_PANE_AS: 'Human' },
      script: (a) => {
        if (a[0] === 'read') return { stdout: ROOM_READ + '\n' }
        if (a[0] === 'who') return { stdout: '{"type":"who","name":"Lin","last":"2026-10-20T09:10:00.000Z","count":2}\n{"type":"who","name":"Ada","last":"2026-10-20T09:00:00.000Z","count":1}\n' }
        if (a[0] === 'whoami') return { stdout: '{"id":"Human","name":"Human"}\n' }
        if (a[0] === 'post') return { stdout: '{"id":"n1","cursor":"9","alias":"lab"}\n' }
        return {}
      },
    })
    await $.session.start({ surface, isInteractive: true, cwd: '/work' })
    await $.command.run({ command: 'agora-room', args: '' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await clock.settle()
    // the pane reads the room as the pane's own session, not the watch's
    expect(s.calls.find((c) => c.argv[0] === 'read')?.env.AGORA_SESSION).toBe('k-pane')

    // subjects, newest activity first, the pane's first open marking nothing unread
    expect(await ui.find({ type: 'Button', key: 'subject-s1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Lin · 1 reply · \d+[smhd]$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Posting to lab › new subject' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'who' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()

    // open a thread: the chip names it; pick who it is for
    await ui.press({ key: 'subject-s1' })
    expect(await ui.find({ type: 'Text', text: 'Posting to lab › Plan the release' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2 messages · started by Ada$/ })).toBeDefined()
    await ui.select({ key: 'to', value: 'Lin' })
    expect(await ui.find({ type: 'Select', key: 'to' })).toMatchObject({ props: { value: 'Lin' } })

    await ui.input({ key: 'compose', text: 'on it' })
    const post = s.calls.find((c) => c.argv[0] === 'post')
    expect(post?.argv).toEqual(['post', 'lab', '--json', '--thread', 's1', '--to', 'Lin', '--', 'on it'])
    expect(post?.env).toEqual({ AGORA_SESSION: 'k-pane', AGORA_ACTOR: 'Human' })

    // back to the list: the chip is a new subject again; presence expands
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: 'Posting to lab › new subject' })).toBeDefined()
    await ui.press({ key: 'who' })
    expect(await ui.find({ type: 'Text', text: /^Lin · 2 messages · last \d+[smhd] ago$/ })).toBeDefined()
    await ui.unmount()
  })
}
