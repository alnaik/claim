// The claim plugin for Claude Code. It does four things: puts the claim
// skill into the system prompt, runs claim itself after every claim tool call,
// checks the quotes in each answer against the files the session read, and
// draws what claim found in a band above the prompt and a pane.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClaimRecord } from '../types'
import { ago, answerCounts, card, isWeb, LOOK, look, name, onPage, shorten, spot } from './cards'
import type { Look } from './cards'

const records = atom({ plugin: 'claim', key: 'records' } as const, [])
const selected = atom({ plugin: 'claim', key: 'selected' } as const, 0)
const isOpen = atom({ plugin: 'claim', key: 'isOpen' } as const, false)
const files = atom({ plugin: 'claim', key: 'files' } as const, [])
const opened = atom({ plugin: 'claim', key: 'opened' } as const, [])
const turn = atom({ plugin: 'claim', key: 'turn' } as const, '')
const unfolded = atom({ plugin: 'claim', key: 'unfolded' } as const, [])
const answers = atom({ plugin: 'claim', key: 'answers' } as const, [])

// The checks that need you: what the pane opens on first, and what the band names.
const PROBLEMS: Look[] = ['not found', 'no file', 'partial', 'error']

// The claim tool's two names: the plugin's own server, and one set up by hand.
const TOOLS = ['mcp__plugin_claim_claim__claim', 'mcp__claim__claim'] as const

const PANE = 'claim'

export const register: Register = on => {
  let skill = ''

  // [stop 9] When the session starts, read skill/SKILL.md from the repo and
  // register /claim. The skill's text then goes at the end of the system prompt
  // on every request, so nobody has to copy the skill by hand.
  on('session.start', async ($, e, next) => {
    try {
      const text = await $.fs.read(`${await repo($)}/skill/SKILL.md`)
      skill = text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
    } catch {
      skill = ''
    }
    await $.command.register({ name: 'claim', description: 'Show what claim found this session, or add a file to check answers against', argumentHint: '[file]' })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!skill) return composed
    return { sections: [...composed.sections, { id: 'claim:skill', text: skill, scope: 'session' as const }] }
  })

  // Claude Code keeps MCP tools behind ToolSearch, where the model sees only a
  // name and has to go and fetch the tool before calling it. Listing claim's
  // tool up front, schema and all, makes the call one step instead of two.
  for (const tool of TOOLS) {
    on('tool.describe', { tool }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
      .catch(($, e, next) => next(e))
  }

  // A claim call on a file the session has already opened (with Read, an @
  // attachment, or an earlier approved claim call) runs without a permission
  // prompt: a prompt nobody notices means no picture at all. Any other file
  // still asks, since claim's picture shows the file's contents and must not
  // be a way around a rule that keeps the model out of it. A link still asks,
  // as claim would download it; a deny rule, or an organization that says
  // claim must ask, still wins.
  for (const tool of TOOLS) {
    on('tool.check', { tool }, async ($, e, next) => {
      const verdict = await next(e)
      const file = String((e.input as { file?: unknown } | null)?.file ?? '')
      if (verdict.decision !== 'ask' || e.ceiling === 'ask' || !file || isWeb(file)) return verdict
      const cwd = await $.session.cwd().catch(() => '')
      const known = await read($, opened)
      const allowed = known.includes(file) || (cwd && known.includes(`${cwd}/${file}`))
      return allowed ? { ...verdict, decision: 'allow' as const } : verdict
    }).catch(($, e, next) => next(e))
  }

  // [stop 10] After the model calls the claim tool, let the call finish, then keep claim's
  // answer as a record. The tool's own result is a picture and one line for the model; the
  // card needs the plain fields (lines, cells, crop path). claim's server leaves those in its
  // temp folder, named after the call (server.py, hand_off), so we read that file; only when it
  // isn't there do we run `claim --json` ourselves. Either way the record comes from claim's
  // own code, never from the model. A call that was refused or failed gets no record.
  for (const tool of TOOLS) {
    on('tool.call', { tool }, async ($, e, next) => {
      const started = await $.clock.now()
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError) return ran
      const file = String(e.file ?? '')
      const quote = String(e.quote ?? '')
      const page = typeof e.page === 'number' ? e.page : null
      const argv = ['uv', 'run', '--project', await repo($), 'claim', '--json', ...(page ? ['--page', String(page)] : []), '--', file, quote]
      const turnId = await read($, turn)
      const found = (await handedOff($, [file, quote, page], started, turnId)) ?? (await check($, argv, file, quote, 'tool', turnId))
      const record = { ...found, call: e.tool_use_id }  // so the card can be drawn under this call
      await update($, records, list => [record, ...list].slice(0, 100))
      await update($, selected, () => -1)
      await remember($, file, true)
      return ran
    }).catch(($, e, next) => next(e))
  }

  // Note which answer is being written, so every record of it can say so and
  // the pane can show one answer's quotes together.
  on('turn.start', async ($, e, next) => {
    await update($, turn, () => e.turnId)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The five ways a file gets onto the list the end-of-turn check searches (stop 14):
  // the Read tool, a path a shell command names, a file a grep turns up, an @ attachment,
  // and a file named in plain words in a prompt. These are guesses, and a file they miss
  // is silently not checked. There will not be a sixth guess: a miss is fixed by typing
  // `/claim path`, which puts the file on the list by hand. A guess that picks wrong
  // files in practice is removed, not refined.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) await remember($, e.file_path, true)
    return ran
  }).catch(($, e, next) => next(e))

  // The model often opens PDFs and spreadsheets with a shell command (cat,
  // pdftotext, a python one-liner) instead of the Read tool, and searches code
  // with grep. Any file a command names, or a search turns up, that claim can
  // read and that is really there goes on the list too.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const cwd = await $.session.cwd().catch(() => '')
    // A file the command writes to (`> out.txt`) was not read, so it is left out.
    const command = String(e.command ?? '').replace(/>>?\s*\S+/g, ' ')
    for (const path of pathsIn(command, cwd)) await remember($, path)
    // A search (grep, rg, git grep) names a folder, and the files it matched are
    // in its output, one per line: `path:12:text`, or a bare path with -l.
    if (/\b(grep|rg|ag)\b/.test(command)) {
      const stdout = typeof ran.result === 'object' && ran.result ? String(ran.result.stdout ?? '') : ''
      const paths = new Set(stdout.split('\n').map(line => line.split(':')[0]?.trim() ?? '').filter(Boolean))
      for (const path of [...paths].slice(0, 20).reverse()) {  // the first match ends up newest
        await remember($, path.startsWith('/') || !cwd ? path : `${cwd}/${path}`)
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // A file attached with @ in a prompt is read by Claude Code itself, not by the
  // Read tool, so it goes on the list here. Each @ in a prompt comes through on its own.
  // It counts as opened even when Claude Code attached nothing (a spreadsheet, which it
  // can't read as text): the person named it, and a file a deny rule covers never gets here.
  on('prompt.mention', async ($, e, next) => {
    const attached = await next(e)
    if (attached.deny === undefined) await remember($, e.path, true)
    return attached
  }).catch(($, e, next) => next(e))

  // A file the user names in plain words ("compare docs/spec.md with the report")
  // goes on the list too, so the answer is checked against it even if the model
  // never opens it. Named is not opened: a claim call on it still asks.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop !== undefined) return entered
    const cwd = await $.session.cwd().catch(() => '')
    for (const path of pathsIn(entered.text, cwd)) await remember($, path)
    return entered
  }).catch(($, e, next) => next(e))

  // When the main conversation's turn ends with an answer, check its quotes (stop 14).
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      await update($, answers, list => [{ turn: e.turnId, text: e.answer }, ...list.filter(a => a.turn !== e.turnId)].slice(0, 20))
      await autoCheck($, e.answer, e.turnId)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // `/claim` opens the pane. `/claim path` puts a file on the list by hand, and counts it
  // as opened (the person typed it), so a claim call on it runs without asking.
  on('command.run', { command: 'claim' }, async ($, e) => {
    const typed = (e.args ?? '').trim().replace(/^@/, '').replace(/^"(.*)"$|^'(.*)'$/, '$1$2')
    if (!typed) {
      await openPane($)
      return { text: 'claim pane opened.' }
    }
    const cwd = await $.session.cwd().catch(() => '')
    const file = typed.startsWith('/') || !cwd ? typed : `${cwd}/${typed}`
    if (!(await readable($, file))) return { text: `${typed}: not a file claim can read.` }
    await remember($, file, true)
    return { text: `${name(file)} added; the next answer is checked against it.` }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) await update($, isOpen, () => false)
    return closed
  }).catch(($, e, next) => next(e))

  // [stop 11] The band above the prompt, shown only while the current answer has checks: from its
  // first claim call or scan record until the next prompt starts a new answer, which hides it again.
  // So what it counts is always this answer, never an earlier one (those are in the pane, folded).
  // It shows "claim", a coloured dot and a count per status, the newest red quote (or figure in no
  // file) named after its count, and "open". Every word on the line is a button, so one click anywhere
  // opens the pane;
  // pressing the named quote opens the pane on its card.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, records)
    const current = await read($, turn)
    const last = list.filter(r => r.turn === current)
    if (last.length === 0 || e.props.hasSurvey) return next(e)
    const open = await read($, isOpen)
    const { Box, Text, Button } = $.ui.resolve(e)
    const present = (Object.keys(LOOK) as Look[]).filter(s => last.some(r => look(r) === s))
    const counts = present.map(s => `● ${last.filter(r => look(r) === s).length} ${LOOK[s].count}`).join(' · ')
    // The item named after its count: the answer's newest red quote, or if none, its newest figure in no file.
    // An index into the whole list, since that is what `selected` points into.
    const lastRed = (status: Look) => list.findIndex(r => r.turn === current && look(r) === status)
    const quoteRed = lastRed('not found')
    const red = quoteRed >= 0 ? quoteRed : lastRed('no file')
    const redLook = red >= 0 ? look(list[red] as ClaimRecord) : null
    const room = e.props.bodyColumns - 'claim '.length - counts.length - ': '.length - (open ? 'esc close' : 'open').length - 2
    const named = red >= 0 && room >= 12 ? shorten(list[red]?.quote ?? '', room) : null
    const press = () => openPane($)
    return (
      <Box width={e.props.bodyColumns} justifyContent="space-between">
        <Box>
          <Button key="claim" plain label="claim " onPress={press} />
          {present.map((status, i) => (
            <Box>
              <Text color={LOOK[status].color}>{LOOK[status].dot} </Text>
              <Button key={`count-${status}`} plain label={`${last.filter(r => look(r) === status).length} ${LOOK[status].count}${status === redLook && named ? ': ' : ''}`} onPress={press} />
              {status === redLook && named ? (
                <Button key="red" plain dimColor label={named} onPress={async () => { await update($, selected, () => red); await openPane($) }} />
              ) : null}
              {i < present.length - 1 ? <Text> · </Text> : null}
            </Box>
          ))}
        </Box>
        {open ? (
          <Text dimColor>esc close</Text>
        ) : (
          <Button key="open" plain dimColor label="open" onPress={press} />
        )}
      </Box>
    )
  })

  // [stop 12] Under Claude's answer, the card of each claim call it made for that answer, in the
  // order the answer says them: the answer first, then where each part of it came from. The call
  // itself stays as Claude Code draws it. An answer has no id here, so its last block is known by
  // its text: the answer the turn ended with (kept at turn.complete) ends with it. Until the turn
  // ends there is no answer to go under, and the cards come in then.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    const said = plain(e.props.text)
    const answer = said.length > 0 ? (await read($, answers)).find(a => plain(a.text).endsWith(said)) : undefined
    if (!answer) return drawn
    const list = await read($, records)
    const calls = inAnswer(list, answer.turn, answer.text).map(i => list[i] as ClaimRecord).filter(r => r.source === 'tool')
    if (calls.length === 0) return drawn
    const ui = $.ui.resolve(e)
    const width = Math.max(20, (e.viewport?.columns ?? 80) - 6)
    const cards = await Promise.all(calls.map(async r => card(ui, r, width, await picture($, e, r, width), () => enlarge($, r))))
    return (
      <ui.Box flexDirection="column">
        {drawn}
        {cards.map(c => <ui.Box paddingLeft={2} marginTop={1} flexDirection="column">{c}</ui.Box>)}
      </ui.Box>
    )
  }).catch(($, e, next) => next(e))

  // [stop 13] The pane: the newest answer's checks in the order the answer says them, one line
  // each with its place (`Hotel › Amount · D18`), and the chosen one's card open under its line: the
  // first problem unless you press another line. A press anywhere on a line opens its card, and
  // a press on the open one closes it. A heading
  // says how many were checked and where they came from (claim calls, the end-of-turn scan).
  // Earlier answers follow, folded to one line each; pressing one unfolds it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, records)
    if (list.length === 0) return <Text dimColor>No claims yet.</Text>
    const width = e.props.bodyColumns
    const now = await $.clock.now()
    const turns = [...new Set(list.map(r => r.turn))]  // newest answer first
    const said = await read($, answers)
    const ordered = (t: string) => inAnswer(list, t, said.find(a => a.turn === t)?.text ?? '')
    const first = ordered(turns[0] ?? '')
    const chosen = await read($, selected)
    const shown = chosen >= 0 && chosen < list.length ? chosen
      : chosen === -2 ? -1 : (first.find(i => PROBLEMS.includes(look(list[i] as ClaimRecord))) ?? first[0] ?? 0)
    const open = [turns[0], list[shown]?.turn, ...(await read($, unfolded))]  // the answers whose lines show
    const opened = list[shown]
    const openCard = opened ? card(ui, opened, width - 2, await picture($, e, opened, width - 2), () => enlarge($, opened)) : null

    const line = (i: number) => {
      const r = list[i] as ClaimRecord
      const place = `${spot(r)}${r.source === 'turn' ? ' · scan' : ''}`
      // The row acts as one button: its dot, quote and place light together and choose it alike.
      const lit = { scope: `claim-row-${i}`, inverse: true }
      const choose = () => update($, selected, () => (i === shown ? -2 : i))
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={LOOK[look(r)].color} hover={lit}>{LOOK[look(r)].dot} </Text>
            <Button key={`row-${i}`} plain dimColor={i !== shown} label={shorten(r.quote, Math.max(12, width - place.length - 5))} hover={lit} onPress={choose} />
            <Button key={`place-${i}`} plain dimColor label={`  ${place}`} hover={lit} onPress={choose} />
          </Box>
          {i === shown ? <Box paddingLeft={2} flexDirection="column">{openCard}<Text> </Text></Box> : null}
        </Box>
      )
    }
    const newest = list.filter(r => r.turn === turns[0])
    const calls = newest.filter(r => r.source === 'tool').length
    return (
      <Box flexDirection="column" width={width}>
        <Text>
          <Text bold>This answer</Text>
          <Text dimColor>  {newest.length} checked · {calls} from claim calls · {newest.length - calls} by the scan</Text>
        </Text>
        {first.map(line)}
        {turns.slice(1).map(t => {
          const group = list.filter(r => r.turn === t)
          const isOpen_ = open.includes(t)
          const toggle = () => update($, unfolded, ts => (ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t]))
          return (
            <Box flexDirection="column">
              <Text> </Text>
              <Box>
                <Button key={`answer-${t}`} plain dimColor label={`${isOpen_ ? '▾' : '▸'} Earlier answer · ${ago(now - (group[0]?.time ?? now))}`} onPress={toggle} />
                {answerCounts(ui, group)}
              </Box>
              {isOpen_ ? ordered(t).map(line) : null}
            </Box>
          )
        })}
      </Box>
    )
  })
}

// A record's crop picture for its card, or null when it has none. The terminal opens the file
// itself; the desktop and editor surfaces can't, so the picture travels inside an SVG, the
// half-size copy so it fits more often, and past the SVG size limit we show the crop's path.
// The picture is at most 14 rows tall, under a claim call and in the pane alike: the conversation
// stays readable, and a big picture redrawn on every scroll is what made the pane stutter.
async function picture($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], r: ClaimRecord, width: number) {
  if (!r.crop) return null
  const [w, tall] = r.size ?? [3, 1]
  const alt = r.matched ?? r.quote
  if (e.surface === 'terminal') {
    const { Image } = $.ui.resolve(e)
    // A terminal cell is about twice as tall as it is wide.
    const rows = Math.max(1, Math.min(14, Math.round((width * tall) / w / 2)))
    return <Image source={{ file: r.crop, format: 'png' }} columns={Math.min(width, 255, Math.round((rows * 2 * w) / tall))} rows={rows} alt={alt} />
  }
  const { Svg, Text } = $.ui.resolve(e)
  const bytes = await $.fs.read(r.crop1x ?? r.crop, { as: 'bytes' }).catch(() => null)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${tall}"><image href="data:image/png;base64,${bytes?.base64}" width="${w}" height="${tall}"/></svg>`
  return bytes && source.length <= 131072 ? <Svg source={source} alt={alt} /> : <Text dimColor>{r.crop}</Text>
}

// Run claim as a separate process and turn its JSON into a record.
// If it fails (uv missing, a crash), the record says so with claim's first
// error line, so the card reads "claim could not run" instead of nothing.
async function check($: EngineInterface, argv: string[], file: string, quote: string, source: ClaimRecord['source'], turnId: string): Promise<ClaimRecord> {
  const time = await $.clock.now()
  try {
    const run = await $.process.run(argv, { timeoutMs: 120000 })
    if (run.exitCode !== 0) return failed(file, quote, source, turnId, time, run.stderr.trim().split('\n')[0] || `exit code ${run.exitCode}`)
    return record(JSON.parse(run.stdout) as ClaimJson, quote, source, turnId, time)
  } catch (error) {
    return failed(file, quote, source, turnId, time, String(error).split('\n')[0] ?? 'unknown error')
  }
}

// The record claim's server left for this call (server.py, hand_off): the file named after the
// sha256 of [file, quote, page] as JSON, written since the call started. Null if there is none,
// so the caller runs claim itself.
async function handedOff($: EngineInterface, call: [string, string, number | null], started: number, turnId: string): Promise<ClaimRecord | null> {
  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(call)))
    const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '') || '/tmp'
    const path = `${tmp}/claim/call-${hex}.json`
    if ((await $.fs.stat(path)).mtimeMs < started - 1000) return null  // an earlier call's, not this one's
    return record(JSON.parse(await $.fs.read(path)) as ClaimJson, call[1], 'tool', turnId, await $.clock.now())
  } catch {
    return null
  }
}

// One object of claim's JSON (from `claim --json`, the server's hand-off, or one entry of
// `claim-scan`): the record's fields as claim prints them, the newer ones possibly missing.
type ClaimJson = Pick<ClaimRecord, 'status' | 'path' | 'sha256' | 'page' | 'lines' | 'matched' | 'crop' | 'excerpt'>
  & Partial<Pick<ClaimRecord, 'crop1x' | 'size' | 'sheet' | 'link' | 'kind' | 'places'>> & { quote?: string }

// One object of claim's JSON as a record.
function record(out: ClaimJson, quote: string, source: ClaimRecord['source'], turnId: string, time: number): ClaimRecord {
  return {
    status: out.status, path: out.path, sha256: out.sha256, page: out.page, lines: out.lines,
    matched: out.matched, quote, crop: out.crop, crop1x: out.crop1x ?? null, size: out.size ?? null, excerpt: out.excerpt, sheet: out.sheet ?? null,
    link: out.link ?? null, kind: out.kind ?? 'quote', places: out.places ?? 1, time, source, turn: turnId,
  }
}

function failed(file: string, quote: string, source: ClaimRecord['source'], turnId: string, time: number, error: string): ClaimRecord {
  return {
    status: 'error', path: file, sha256: null, page: null, lines: null, matched: null, quote,
    crop: null, crop1x: null, size: null, excerpt: null, sheet: null, link: null, kind: 'quote', time, source, turn: turnId, error,
  }
}

// [stop 14] The end-of-turn check. The whole answer goes to `claim-scan` with the
// ten files the session read most recently, newest first. The scan (scan.py, stop 15)
// finds every run of eight words the answer shares with a file, quotation marks or
// not, and every figure, and checks each one; nobody has to decide what counts as a
// quote. What comes back becomes records, except one that lands on the same place as a
// claim call of this turn (sameSpot, below): that place already has its card. So a quote
// or figure from nowhere still shows even when the model never called claim, and a
// place shows once.
async function autoCheck($: EngineInterface, answer: string, turnId: string) {
  const list = await read($, files)
  if (list.length === 0) return
  const called = (await read($, records)).filter(r => r.source === 'tool' && r.turn === turnId)
  const argv = ['uv', 'run', '--project', await repo($), 'claim-scan', '--', answer.slice(0, 100_000), ...list.slice(0, 10)]
  const time = await $.clock.now()
  let made: ClaimRecord[]
  try {
    const run = await $.process.run(argv, { timeoutMs: 120000 })
    if (run.exitCode !== 0) made = [failed(list[0] ?? '', 'the answer', 'turn', turnId, time, run.stderr.trim().split('\n')[0] || `exit code ${run.exitCode}`)]
    else made = (JSON.parse(run.stdout) as ClaimJson[]).map(out => record(out, String(out.quote), 'turn', turnId, time))
  } catch (error) {
    made = [failed(list[0] ?? '', 'the answer', 'turn', turnId, time, String(error).split('\n')[0] ?? 'unknown error')]
  }
  const fresh = made.filter(r => !called.some(c => sameSpot(r, c)))  // a claim call's card already shows that place
  if (fresh.length === 0) return
  await update($, records, all => [...fresh.reverse(), ...all].slice(0, 100))
  await update($, selected, () => -1)
}

// Whether two records point at the same place in the same file: a shared cell on the same row
// of the same sheet, overlapping lines of a text file, or the same page and overlapping page lines.
// A record with no place (a figure in no file, a quote that wasn't found) is never the same as another.
function sameSpot(a: ClaimRecord, b: ClaimRecord): boolean {
  if (!a.path || a.path !== b.path || a.status === 'not found' || b.status === 'not found') return false
  const [ta, tb] = [a.excerpt, b.excerpt].map(x => (x && !Array.isArray(x) ? x : null))
  if (ta && tb) {
    if (ta.hit === null || tb.hit === null || a.sheet !== b.sheet || ta.numbers[ta.hit] !== tb.numbers[tb.hit]) return false
    return ta.cells.length === 0 || tb.cells.length === 0 || ta.cells.some(c => tb.cells.includes(c))
  }
  if (!a.lines || !b.lines || (onPage(a) && a.page !== b.page)) return false
  return a.lines[0] <= b.lines[1] && b.lines[0] <= a.lines[1]
}

// Put a file at the top of the session's read list, if claim can read it.
// Links are left out, so the end-of-turn check never goes to the network.
// `opened` means the session really opened it (Read, @, an approved claim call),
// which is what lets a later claim call on it run without asking; a file a shell
// command merely named is searched but not trusted that far.
async function remember($: EngineInterface, file: string, opened_ = false) {
  if (!file || isWeb(file) || !(await readable($, file))) return
  await update($, files, list => [file, ...list.filter(f => f !== file)].slice(0, 50))
  if (opened_) await update($, opened, list => [file, ...list.filter(f => f !== file)].slice(0, 50))
}

// Every word of a shell command or a prompt that could be a file: quoted text
// as a whole (a path may have spaces), then every bare word, inside quotes too.
// A path or a file name has a dot or a slash; a word starting with - is a flag.
// A full stop or question mark at the end is the sentence's, not the name's,
// and a leading @ is how a prompt attaches a file. A relative one is taken from the session folder.
function pathsIn(text: string, cwd: string): string[] {
  const quoted = [...text.matchAll(/"([^"]+)"|'([^']+)'/g)].map(m => m[1] ?? m[2] ?? '')
  const words = [...quoted, ...text.split(/[\s"'|;&<>(),=]+/)].map(word => word.replace(/^@/, '').replace(/[.?!:]+$/, ''))
  const paths = words.filter(word => /[./]/.test(word) && !word.startsWith('-'))
  return paths.map(word => (word.startsWith('/') || !cwd ? word : `${cwd}/${word}`))
}

// The kinds of file claim reads that aren't plain text: PDFs, spreadsheets, pictures.
const KINDS = ['.pdf', '.xlsx', '.xlsm', '.xls', '.png', '.jpg', '.jpeg']

const isText = new Map<string, boolean>()  // file version -> whether its first kilobyte has no zero byte

// Whether claim can read a file: one of KINDS, or any text file, whatever its
// name (.css, .swift, a Makefile). A file is text when its first kilobyte has
// no zero byte, which every zip, picture and program file does.
async function readable($: EngineInterface, file: string): Promise<boolean> {
  try {
    const stat = await $.fs.stat(file)
    if (stat.kind !== 'file') return false
    if (KINDS.includes(file.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '')) return true
    if (stat.size > 2_000_000) return false  // a text file this big is a log or data dump, not something quoted
    // The engine reads a file whole, so the answer is kept per version of the file: the same
    // path named in every prompt is read once, not every time.
    const version = `${file}\0${stat.mtimeMs}\0${stat.size}`
    if (!isText.has(version)) {
      const { base64 } = await $.fs.read(file, { as: 'bytes' })
      isText.set(version, !atob(base64.slice(0, 1368)).includes('\0'))  // 1368 base64 characters are the first 1026 bytes
    }
    return isText.get(version) ?? false
  } catch {
    return false  // not there, or not ours to read
  }
}

// Where claim's code is. Installed (or loaded with --plugin-dir .), the plugin
// root is the repo itself; loaded with --plugin-dir plugin, it is the root's
// parent; a session started inside the repo also counts; otherwise CLAIM_HOME says.
async function repo($: EngineInterface): Promise<string> {
  const root = $.plugin.root.replace(/\/$/, '')
  const cwd = await $.session.cwd().catch(() => '')  // a test harness may not offer it
  for (const dir of [root, root.replace(/\/[^/]+$/, ''), cwd]) {
    if (!dir) continue
    if (await $.fs.exists(`${dir}/claim/core.py`)) return dir
  }
  return (await $.env.get('CLAIM_HOME')) ?? root
}

// Open a record's picture full size in the computer's own viewer (Preview on a Mac).
async function enlarge($: EngineInterface, r: ClaimRecord) {
  if (!r.crop) return
  const run = await $.process.run(['open', r.crop], { timeoutMs: 10000 }).catch(() => null)
  if (!run || run.exitCode !== 0) await $.process.run(['xdg-open', r.crop], { timeoutMs: 10000 }).catch(() => null)
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'claim', focus: true, closeOnEscape: true, columns: 72 })  // a fullscreen terminal docks it on the right
  await update($, isOpen, () => true)
}

// The indices of one answer's records in the order the answer says them: each by where its quote
// (or its first words) is in the answer's text; one the answer never says (Claude checked it and
// then wrote it otherwise) goes last; ties, and answers not yet kept, in the order they were made.
function inAnswer(list: ClaimRecord[], turnId: string, answer: string): number[] {
  const text = plain(answer)
  const at = (r: ClaimRecord) => {
    const quote = plain(r.quote)
    const found = text.indexOf(quote) >= 0 ? text.indexOf(quote) : text.indexOf(quote.split(' ').slice(0, 5).join(' '))
    return quote && found >= 0 ? found : Infinity
  }
  return list.map((_, i) => i).filter(i => list[i]?.turn === turnId)
    .sort((a, b) => at(list[a] as ClaimRecord) - at(list[b] as ClaimRecord) || b - a)  // newest first in the list, so made first is the higher index
}

// Text as compared: no markdown marks or quotation marks, curly ones folded, one space, lower case.
function plain(text: string): string {
  return text.replace(/[*_`>#|]/g, ' ').replace(/[“”"‘’']/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}
