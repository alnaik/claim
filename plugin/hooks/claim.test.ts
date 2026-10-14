import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The first 24 bytes of a PNG that is 600 wide and 200 tall, as base64.
const PNG = btoa('\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x02\x58\x00\x00\x00\xc8')

// The made-up disk: which paths are there. A .png is a picture, a .zip or
// .bin is binary (a zero byte near the start), anything else is text.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function disk(on: any, there: (path: string) => boolean = () => true) {
  on('fs.exists', ($: unknown, e: { path: string }) => ({ value: there(e.path) }))
  on('fs.stat', ($: unknown, e: { path: string }) => {
    if (!there(e.path)) throw new Error('no such file')
    return { value: { kind: 'file' as const, size: 100, mtimeMs: 0, isLink: false } }
  })
}
const bytes = (path: string) => ({ base64: path.endsWith('.png') ? PNG : /\.(zip|bin)$/.test(path) ? btoa('PK\x03\x04\x00\x00') : btoa('plain text') })

// What `claim --json` prints, per quote the test asks about.
const ANSWERS: Record<string, object> = {
  'margins stay stable': {
    status: 'exact', page: 2, path: '/docs/report.pdf', sha256: '84e3e31641f1a72c',
    matched: 'margins stay stable', lines: null, excerpt: null, crop: '/tmp/claim-1.png',
    link: 'https://example.org/report.pdf#page=2',
  },
  'revenue tripled overnight': {
    status: 'not found', page: 2, path: '/docs/report.pdf', sha256: '84e3e31641f1a72c',
    matched: null, lines: null, excerpt: null, crop: '/tmp/claim-2.png',
  },
}

test('band and pane show what claim found', async ($, on) => {
  mock.clock(on)
  disk(on)
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : '---\nname: claim\n---\nCall claim.' }))
  on('process.run', ($, e) => {
    const answer = ANSWERS[e.argv.at(-1) ?? '']
    if (!answer) return { value: { exitCode: 1, stdout: '', stderr: 'uv: claim crashed\nmore', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: JSON.stringify(answer), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'the model sees this, the plugin never draws it' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  // Stands for the engine's own drawing, which the band leaves alone until the first record.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine') as RenderElement
  })

  // The skill's text, without its front matter, goes last in the system prompt.
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(composed.sections.at(-1)).toEqual({ id: 'claim:skill', text: 'Call claim.', scope: 'session' })

  const band = { plugin: 'claim', component: 'AbovePrompt', requestId: 'band' } as const
  const bandProps = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4, contentRows: 1 }, view: {} } as never

  // No records yet: the band draws nothing of its own.
  const empty = await $.ui.mount({ ...band, surface: 'terminal', props: bandProps })
  expect(await empty.find({ text: /claim/ })).toBeUndefined()
  expect(await empty.find({ text: 'engine' })).toBeDefined()
  await empty.unmount()

  // The bundled server's tool name for two calls, the hand-configured name for one.
  await $.tool.call({ tool: 'mcp__plugin_claim_claim__claim', file: 'report.pdf', quote: 'margins stay stable', page: 2 })
  await $.tool.call({ tool: 'mcp__claim__claim', file: 'report.pdf', quote: 'revenue tripled overnight', page: 2 })
  await $.tool.call({ tool: 'mcp__plugin_claim_claim__claim', file: 'report.pdf', quote: 'something else', page: 2 })

  const ui = await $.ui.mount({ ...band, surface: 'terminal', props: bandProps })
  expect(await ui.find({ text: /1 in file/ })).toBeDefined()
  expect(await ui.find({ text: /1 not in file/ })).toBeDefined()
  expect(await ui.find({ text: /1 could not run/ })).toBeDefined()
  expect((await ui.find({ key: 'open' }))?.props.label).toBe('open')
  // The not-found count names its quote; pressing the name opens the pane on that card.
  expect((await ui.find({ key: 'red' }))?.props.label).toBe('revenue tripled…')  // cut to the room left on an 80-column line
  // Pressing the band opens the pane, and the hint says how to close it.
  await ui.press({ key: 'open' })
  expect(await ui.find({ text: 'esc close' })).toBeDefined()
  await ui.press({ key: 'red' })
  const landed = await $.ui.mount({ plugin: 'claim', surface: 'terminal', component: 'Pane', requestId: 'claim', props: { title: 'claim', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30, contentRows: 30 }, view: {} } as never })
  expect(await landed.find({ text: /^Not in the file$/ })).toBeDefined()
  await landed.press({ key: 'row-0' })
  await landed.unmount()
  await ui.unmount()

  const paneProps = { title: 'claim', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30, contentRows: 30 }, view: {} } as never
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'claim', surface, component: 'Pane', requestId: 'claim', props: paneProps })
    // The newest record is the error.
    expect(await pane.find({ text: /claim could not run/ })).toBeDefined()
    expect(await pane.find({ text: /uv: claim crashed/ })).toBeDefined()
    // Press the oldest row: the found card comes up, with its picture.
    await pane.press({ key: 'row-2' })
    expect(await pane.find({ text: /^In the file$/ })).toBeDefined()
    expect(await pane.find({ text: /report\.pdf · page 2/ })).toBeDefined()
    expect(await pane.find({ text: /84e3e316/ })).toBeDefined()
    expect(await pane.find({ text: 'https://example.org/report.pdf#page=2' })).toBeDefined()
    expect(await pane.find({ type: surface === 'terminal' ? 'Image' : 'Svg' })).toBeDefined()
    expect(await pane.find({ text: /Don't rely on it/ })).toBeUndefined()
    // The middle row: not found, with its help line.
    await pane.press({ key: 'row-1' })
    expect(await pane.find({ text: /^Not in the file$/ })).toBeDefined()
    expect(await pane.find({ text: /This quote is not in the file. Don't rely on it./ })).toBeDefined()
    expect(await pane.find({ text: /“revenue tripled overnight”/ })).toBeDefined()
    await pane.press({ key: 'row-0' })
    await pane.unmount()
  }
})

// What `claim --json` prints for a markdown file and a table.
const TEXT_AND_TABLE: Record<string, object> = {
  "we'll ship the beta on 14 March": {
    status: 'exact', page: 2, path: '/docs/notes.md', sha256: '1610c7e8e420b84b',
    matched: "we'll ship the beta on 14 March", lines: [48, 48], crop: '/tmp/claim-3.png', crop1x: '/tmp/claim-3-1x.png',
    excerpt: [[46, 'A smaller learning rate.'], [47, ''], [48, 'Decision: we’ll ship the beta on 14 March — after the security review.'], [49, ''], [50, '## Week 6']],
  },
  'host of the 2031 regional games': {
    status: 'partial', page: 1, path: '/docs/cities.xlsx', sheet: 'cities', sha256: '283d458d87a430f9',
    matched: 'host of the 2031 regional games', lines: null, crop: '/tmp/claim-4.png', crop1x: '/tmp/claim-4-1x.png',
    excerpt: {
      header: ['city', 'country', 'population', 'note'],
      rows: [['Graz', 'IT', '656845', 'port city'], ['Malmo', 'FR', '693968', 'host of the 2031 regional games'], ['Aarhus', 'PT', '731091', 'old town']],
      numbers: [17, 18, 19],
      hit: 1,
      cells: [3],
    },
  },
}

test('text and table records draw lines and rows, not a picture', async ($, on) => {
  mock.clock(on)
  disk(on)
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => ({
    value: { exitCode: 0, stdout: JSON.stringify(TEXT_AND_TABLE[e.argv.at(-1) ?? '']), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', () => ({ result: 'ok' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'mcp__claim__claim', file: 'notes.md', quote: "we'll ship the beta on 14 March" })
  await $.tool.call({ tool: 'mcp__claim__claim', file: 'cities.csv', quote: 'host of the 2031 regional games' })

  const paneProps = { title: 'claim', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30, contentRows: 30 }, view: {} } as never
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'claim', surface, component: 'Pane', requestId: 'claim', props: paneProps })
    // Newest first: the table. Its header row dim, the hit row's cells padded into columns.
    expect(await pane.find({ text: /^Partly in the file$/ })).toBeDefined()
    expect(await pane.find({ text: /cities\.xlsx · sheet cities · cell D18/ })).toBeDefined()
    // Around the match: the label column A, `…` for B, then C and the matched D, letters on top.
    expect(await pane.find({ text: '    A       …  C           D' })).toBeDefined()
    expect(await pane.find({ text: '    city    …  population  note' })).toBeDefined()
    // In words above the grid: the row's label, the column's header, the value.
    expect(await pane.find({ text: 'Malmo › note = host of the 2031 regional games' })).toBeDefined()
    // The matched column's letter and the hit row's number are coloured.
    const coloured = (await pane.findAll({ type: 'Text' })).filter(t => t.props.color === 'warning').map(t => t.text)
    expect(coloured).toContain('D')
    expect(coloured).toContain('18  ')
    // Only the matched cell is tinted amber, as the quote was only partly found.
    const tinted = (await pane.findAll({ type: 'Text' })).filter(t => t.props.backgroundColor)
    expect(tinted.map(t => [t.text, t.props.backgroundColor])).toEqual([['host of the 2031 region…', 'warning']])
    expect(await pane.find({ text: /^18 {2}Malmo {3}… {2}693968 {6}host of the 2031 region…$/ })).toBeDefined()
    expect(await pane.find({ text: /^17  Graz {4}… {2}656845/ })).toBeDefined()
    expect(await pane.find({ type: 'Image' })).toBeUndefined()
    expect(await pane.find({ type: 'Svg' })).toBeUndefined()
    // The markdown file: line numbers in the gutter, the matched line itself.
    await pane.press({ key: 'row-1' })
    expect(await pane.find({ text: /notes\.md · line 48/ })).toBeDefined()
    expect(await pane.find({ text: /^48 {2}$/ })).toBeDefined()
    expect(await pane.find({ text: /^46 {2}$/ })).toBeDefined()
    expect((await pane.find({ type: 'Text', text: /^Decision: we’ll ship the beta on 14 March/ }))?.props.backgroundColor).toBe('diffAdded')
    expect((await pane.find({ type: 'Text', text: '## Week 6' }))?.props.backgroundColor).toBeUndefined()
    expect(await pane.find({ type: 'Image' })).toBeUndefined()
    expect(await pane.find({ type: 'Svg' })).toBeUndefined()
    await pane.press({ key: 'row-0' })
    await pane.unmount()
  }
})

// What `claim --json` prints for the passages an answer quotes, against report.pdf.
// What `claim-scan` prints for an answer: one record per QUOTED passage the answer
// holds, against the first file given, unless `at` says otherwise for a passage.
function scanned(argv: readonly string[], at: (quote: string, files: string[]) => object = () => ({})) {
  const [answer, ...files] = argv.slice(argv.indexOf('--') + 1)
  const plain = (answer ?? '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[*_>`]/g, '').replace(/\s+/g, ' ').toLowerCase()
  const out = Object.entries(QUOTED).filter(([q]) => plain.includes(q.toLowerCase())).map(([q, r]) => ({ ...r, path: `/work/${files[0]}`, quote: q, kind: 'quote', ...at(q, files) }))
  return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}
// The files a `claim-scan` run was given, newest first.
const scannedFiles = (argv: readonly string[]) => argv.slice(argv.indexOf('--') + 2)

const QUOTED: Record<string, object> = {
  'Operating margins stay stable across all four regions this year': {
    status: 'exact', page: 2, path: '/work/fixtures/report.pdf', sha256: '84e3e31641f1a72c',
    matched: 'Operating margins stay stable across all four regions this year', lines: [6, 7], excerpt: null, crop: '/tmp/claim-5.png',
  },
  'Revenue tripled overnight after the board approved the new plan': {
    status: 'not found', page: 1, path: '/work/fixtures/report.pdf', sha256: '84e3e31641f1a72c',
    matched: null, lines: null, excerpt: null, crop: '/tmp/claim-6.png',
  },
  'Headcount grew by twelve percent in the second half of the year': {
    status: 'partial', page: 2, path: '/work/fixtures/report.pdf', sha256: '84e3e31641f1a72c',
    matched: 'grew by twelve percent in the second half', lines: [11, 11], excerpt: null, crop: '/tmp/claim-7.png',
  },
}

test('quotes in the answer are checked against the files the session read', async ($, on) => {
  mock.clock(on)
  const runs: string[][] = []
  disk(on)
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv.includes('claim-scan')) return scanned(e.argv)
    return { value: { exitCode: 0, stdout: JSON.stringify(QUOTED[e.argv.at(-1) ?? '']), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', ($, e) => ({ text: e.text, turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  // An answer before anything was read: nothing to check against, nothing runs.
  const turn = { turnId: 't0', durationMs: 1000, isAborted: false, reason: 'answer' } as const
  await $.turn.complete({ ...turn, answer: 'It says "Operating margins stay stable across all four regions this year".' })
  expect(runs).toHaveLength(0)

  // The model reads the report (and a file claim can't read, which is left out),
  // then checks one quote with the tool itself.
  await $.turn.start({ text: 'what does the report say?', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'fixtures/report.pdf' })
  await $.tool.call({ tool: 'Read', file_path: 'fixtures/archive.zip' })
  await $.tool.call({ tool: 'mcp__claim__claim', file: 'fixtures/report.pdf', quote: 'Headcount grew by twelve percent in the second half of the year' })
  expect(runs).toHaveLength(1)

  // Its answer quotes three passages. The whole answer goes to one scan with the
  // file; the passage the tool already checked lands on the same page and line, so it is dropped.
  await $.turn.complete({
    ...turn,
    turnId: 't1',
    answer:
      'The report says “Operating margins stay stable across all four regions this year” and ' +
      '"Revenue tripled overnight after the board approved the new plan". It also notes ' +
      '“headcount grew by twelve percent in the second  half of the year” and calls it "a good year".',
  })
  expect(runs).toHaveLength(2)
  expect(runs[1]).toContain('claim-scan')
  expect(scannedFiles(runs[1] ?? [])).toEqual(['fixtures/report.pdf'])

  const band = { plugin: 'claim', component: 'AbovePrompt', requestId: 'band', surface: 'terminal' } as const
  const bandProps = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4, contentRows: 1 }, view: {} } as never
  const ui = await $.ui.mount({ ...band, props: bandProps })
  // The tool's own record is the partly found one; the answer's two are one found, one not.
  expect(await ui.find({ text: /1 in file/ })).toBeDefined()
  expect(await ui.find({ text: /1 partly/ })).toBeDefined()
  expect(await ui.find({ text: /1 not in file/ })).toBeDefined()
  await ui.unmount()

  // The two the scan found say so after their place; the tool's does not. The worst comes first, its card open.
  const paneProps = { title: 'claim', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30, contentRows: 30 }, view: {} } as never
  const pane = await $.ui.mount({ plugin: 'claim', surface: 'terminal', component: 'Pane', requestId: 'claim', props: paneProps })
  expect(await pane.findAll({ type: 'Text', text: / · scan$/ })).toHaveLength(2)
  expect(await pane.find({ text: /^ {2}3 checked · 1 from claim calls · 2 by the scan$/ })).toBeDefined()
  expect(await pane.find({ text: /^Not in the file$/ })).toBeDefined()
  await pane.press({ key: 'row-1' })
  expect(await pane.find({ text: /^In the file$/ })).toBeDefined()
  await pane.unmount()
})

test('the claim tool is listed up front, not behind tool search', async ($, on) => {
  on('tool.describe', ($, e) => ({ description: e.description, isDeferred: true }))
  for (const tool of ['mcp__plugin_claim_claim__claim', 'mcp__claim__claim']) {
    const described = await $.tool.describe({ tool, description: 'Show the source page', isDeferred: true, provider: { plugin: 'mcp:claim', tier: 'user' } } as never)
    expect(described.isDeferred).toBe(false)
  }
  // Other tools keep their place.
  const other = await $.tool.describe({ tool: 'mcp__other__thing', description: 'x', isDeferred: true, provider: { plugin: 'mcp:other', tier: 'user' } } as never)
  expect(other.isDeferred).toBe(true)
})

test('files attached with @ are checked, in later turns too', async ($, on) => {
  mock.clock(on)
  const runs: string[][] = []
  disk(on, path => !path.endsWith('gone.pdf'))
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return scanned(e.argv)
  })
  // The engine attaches nothing for a missing file, nor for a spreadsheet it can't read as text.
  on('prompt.mention', ($, e) => ({ type: /gone\.pdf|\.xlsx$/.test(e.path) ? null : 'file' as const }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  // Three files attached in one prompt (the workbook attached as nothing, but named), and one that isn't there (left out).
  await $.prompt.mention({ mention: 'a.pdf', path: '/work/a.pdf' })
  await $.prompt.mention({ mention: 'b.md', path: '/work/b.md' })
  await $.prompt.mention({ mention: 'd.xlsx', path: '/work/d.xlsx' })
  await $.prompt.mention({ mention: 'gone.pdf', path: '/work/gone.pdf' })
  const turn = { durationMs: 1000, isAborted: false, reason: 'answer' } as const
  await $.turn.complete({ ...turn, turnId: 't1', answer: 'It says "Revenue tripled overnight after the board approved the new plan".' })
  // The attachments go to the scan, newest first.
  expect(runs.map(scannedFiles)).toEqual([['/work/d.xlsx', '/work/b.md', '/work/a.pdf']])

  // A follow-up question with a new attachment: checked again, the new file first.
  await $.prompt.mention({ mention: 'c.csv', path: '/work/c.csv' })
  await $.turn.complete({ ...turn, turnId: 't2', answer: 'And later: "Operating margins stay stable across all four regions this year".' })
  expect(scannedFiles(runs[1] ?? [])).toEqual(['/work/c.csv', '/work/d.xlsx', '/work/b.md', '/work/a.pdf'])

  // A follow-up with no new attachment still gets its quotes checked.
  await $.turn.complete({ ...turn, turnId: 't3', answer: 'Lastly "Headcount grew by twelve percent in the second half of the year".' })
  expect(scannedFiles(runs[2] ?? [])).toEqual(['/work/c.csv', '/work/d.xlsx', '/work/b.md', '/work/a.pdf'])
})

test('files named in a prompt are checked too, but a claim call on them still asks', async ($, on) => {
  mock.clock(on)
  const runs: string[][] = []
  disk(on, path => ['/work/docs/spec.md', '/work/claim/core.py'].includes(path))
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return scanned(e.argv)
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  // Named in plain words, no @; a file that isn't there is left out.
  await $.prompt.submit({ text: 'Compare docs/spec.md with gone.md.' } as never)
  await $.turn.complete({ turnId: 't1', durationMs: 1000, isAborted: false, reason: 'answer', answer: 'It says "Revenue tripled overnight after the board approved the new plan".' })
  expect(runs.map(scannedFiles)).toEqual([['/work/docs/spec.md']])
  // Named is not opened: a claim call on it still asks.
  const verdict = await $.tool.check({ tool: 'mcp__plugin_claim_claim__claim', input: { file: '/work/docs/spec.md', quote: 'q' } })
  expect(verdict.decision).toBe('ask')
})

test('files a shell command reads are checked too', async ($, on) => {
  mock.clock(on)
  const runs: string[][] = []
  const there = ['/work/docs/report.pdf', '/data/q3 notes.md', '/data/book.xlsx', '/work/claim/core.py', '/work/written.md']
  disk(on, path => there.includes(path))
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return scanned(e.argv)
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  // A relative PDF, a quoted path with a space, a spreadsheet in a python
  // one-liner; a file that isn't there and a script claim can't read are left out.
  await $.tool.call({ tool: 'Bash', command: 'pdftotext docs/report.pdf - | head' })
  await $.tool.call({ tool: 'Bash', command: 'cat "/data/q3 notes.md" missing.csv' })
  await $.tool.call({ tool: 'Bash', command: "python -c \"import pandas; print(pandas.read_excel('/data/book.xlsx'))\" && ls archive.zip" })
  // A file the command writes to was not read, so a quote can't be "found" in the model's own output.
  await $.tool.call({ tool: 'Bash', command: 'echo "Revenue tripled overnight after the board approved the new plan" > written.md' })
  await $.turn.complete({ turnId: 't1', durationMs: 1000, isAborted: false, reason: 'answer', answer: 'It says "Revenue tripled overnight after the board approved the new plan".' })
  expect(runs.map(scannedFiles)).toEqual([['/data/book.xlsx', '/data/q3 notes.md', '/work/docs/report.pdf']])
})

test('/claim path puts a file on the list by hand, and counts it as opened', async ($, on) => {
  mock.clock(on)
  const runs: string[][] = []
  disk(on, path => ['/work/docs/report.pdf', '/work/claim/core.py'].includes(path))
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return scanned(e.argv)
  })
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  // A relative path from the session folder; a file that isn't there is refused with a message.
  const added = await $.command.run({ command: 'claim', args: 'docs/report.pdf' } as never)
  expect(added.text).toBe('report.pdf added; the next answer is checked against it.')
  const missing = await $.command.run({ command: 'claim', args: 'docs/missing.pdf' } as never)
  expect(missing.text).toBe('docs/missing.pdf: not a file claim can read.')
  await $.turn.complete({ turnId: 't1', durationMs: 1000, isAborted: false, reason: 'answer', answer: 'It says "Revenue tripled overnight after the board approved the new plan".' })
  expect(runs.map(scannedFiles)).toEqual([['/work/docs/report.pdf']])
  // Typed by the person, so a claim call on it needs no permission prompt.
  const verdict = await $.tool.check({ tool: 'mcp__plugin_claim_claim__claim', input: { file: 'docs/report.pdf', quote: 'q' } })
  expect(verdict.decision).toBe('allow')
})

test('the pane shows each answer\'s quotes together under one heading', async ($, on) => {
  mock.clock(on)
  disk(on)
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => {
    // The revenue line is in a.pdf.
    if (e.argv.includes('claim-scan')) return scanned(e.argv, q => q.startsWith('Revenue') ? { status: 'exact', path: '/work/a.pdf' } : {})
    return { value: { exitCode: 0, stdout: JSON.stringify({ ...QUOTED[e.argv.at(-1) ?? ''], path: e.argv.at(-2) }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', ($, e) => ({ text: e.text, turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const done = { durationMs: 1000, isAborted: false, reason: 'answer' } as const

  // The first answer draws on two files: one quote checked by the tool, one by the plugin.
  await $.turn.start({ text: 'compare them', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/work/a.pdf' })
  await $.tool.call({ tool: 'mcp__claim__claim', file: '/work/b.pdf', quote: 'Operating margins stay stable across all four regions this year' })
  await $.turn.complete({ ...done, turnId: 't1', answer: 'And "Revenue tripled overnight after the board approved the new plan".' })
  // The follow-up quotes one more passage.
  await $.turn.start({ text: 'and headcount?', turnId: 't2' } as never)
  await $.turn.complete({ ...done, turnId: 't2', answer: 'It says "Headcount grew by twelve percent in the second half of the year".' })

  const paneProps = { title: 'claim', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30, contentRows: 30 }, view: {} } as never
  const pane = await $.ui.mount({ plugin: 'claim', surface: 'terminal', component: 'Pane', requestId: 'claim', props: paneProps })
  // The newest answer first, its one check open; the earlier answer folded to one line with its counts.
  expect(await pane.find({ text: /^ {2}1 checked · 0 from claim calls · 1 by the scan$/ })).toBeDefined()
  expect(await pane.find({ text: /^Partly in the file$/ })).toBeDefined()
  expect(await pane.find({ text: ' · ● 2 in file' })).toBeDefined()
  const lines = async () => (await pane.findAll({ type: 'Button' })).map(b => String(b.props.label))
  expect((await lines()).some(l => /^Operating margins stay stable/.test(l))).toBe(false)
  // Pressing the earlier answer unfolds it: its two lines, the tool's and the scan's.
  await pane.press({ key: 'answer-t1' })
  expect((await lines()).some(l => /^Operating margins stay stable/.test(l))).toBe(true)
  expect(await pane.find({ type: 'Text', text: /a\.pdf · page 1 · scan$/ })).toBeDefined()
  await pane.unmount()
})

test('a claim call on a file the session opened runs without asking; other files, links and denies still do', async ($, on) => {
  mock.clock(on)
  disk(on)
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(ANSWERS['margins stay stable']), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('tool.check', ($, e) => ({ decision: String((e.input as { file: string }).file).includes('secret') ? 'deny' as const : 'ask' as const }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ask = (file: string) => $.tool.check({ tool: 'mcp__plugin_claim_claim__claim', input: { file, quote: 'q' } })
  // Nothing opened yet: a file the model names out of the blue still asks (claim's picture would show it).
  expect((await ask('/work/report.pdf')).decision).toBe('ask')
  await $.tool.call({ tool: 'Read', file_path: '/work/report.pdf' })
  expect((await ask('/work/report.pdf')).decision).toBe('allow')
  expect((await ask('report.pdf')).decision).toBe('allow')  // the same file, named from the session folder
  expect((await ask('/work/other.pdf')).decision).toBe('ask')
  expect((await ask('https://example.org/a.pdf')).decision).toBe('ask')
  await $.tool.call({ tool: 'Read', file_path: '/work/secret.pdf' })
  expect((await ask('/work/secret.pdf')).decision).toBe('deny')
  // A file a shell command named was not necessarily read, so it is searched but not trusted this far.
  await $.tool.call({ tool: 'Bash', command: 'ls -l /work/listed.pdf' })
  expect((await ask('/work/listed.pdf')).decision).toBe('ask')
  // A file an earlier claim call was approved for is now open.
  await $.tool.call({ tool: 'mcp__claim__claim', file: '/work/notes.md', quote: 'q' })
  expect((await $.tool.check({ tool: 'mcp__claim__claim', input: { file: '/work/notes.md', quote: 'q' } })).decision).toBe('allow')
})

test('the whole answer goes to the scan as written, and a figure from nowhere says so', async ($, on) => {
  mock.clock(on)
  const runs: string[][] = []
  disk(on)
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const total = { ...QUOTED['Revenue tripled overnight after the board approved the new plan'], path: '', crop: null, crop1x: null, quote: '$3,382.50', kind: 'figure' }
    return { value: { exitCode: 0, stdout: JSON.stringify([{ ...TEXT_AND_TABLE["we'll ship the beta on 14 March"], path: '/work/notes.md', quote: "we'll ship the beta on 14 March", kind: 'figure', places: 3 }, total]), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', ($, e) => ({ text: e.text, turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'what do the notes say?', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/work/notes.md' })
  await $.turn.complete({
    turnId: 't1', durationMs: 1000, isAborted: false, reason: 'answer',
    answer: 'The notes say:\n\n> **Decision:** we’ll ship the beta on 14 March —\n> after the security review, not before.\n\nThe total comes to **$3,382.50**.',
  })
  expect(runs).toHaveLength(1)
  expect(runs[0]?.[runs[0].indexOf('--') + 1]).toContain('> **Decision:** we’ll ship the beta')  // as written, markdown and all
  expect(scannedFiles(runs[0] ?? [])).toEqual(['/work/notes.md'])
  // Newest record first: the figure, with the help line for a figure in no file.
  const paneProps = { title: 'claim', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30, contentRows: 30 }, view: {} } as never
  const pane = await $.ui.mount({ plugin: 'claim', surface: 'terminal', component: 'Pane', requestId: 'claim', props: paneProps })
  // A figure in no file is not red: its own word and a hollow dot, since it may be a sum worked out right.
  expect(await pane.find({ text: /^In no file$/ })).toBeDefined()
  expect(await pane.find({ text: '○' })).toBeDefined()
  expect(await pane.find({ text: /^This figure is in none of the files checked/ })).toBeDefined()
  expect(await pane.find({ text: /in none of the files checked$/ })).toBeDefined()  // the card names no file
  // The older record, a figure the scan found in three rows, says it was lit in the first of them.
  await pane.press({ key: 'row-1' })
  expect(await pane.find({ text: /notes\.md · lines 48–48? · 1 of 3 places$|notes\.md · line 48 · 1 of 3 places$/ })).toBeDefined()
  expect(await pane.find({ text: /^ {2}2 checked · 0 from claim calls · 2 by the scan$/ })).toBeDefined()
  await pane.unmount()
  // With no red quote, the band names the figure after its own count.
  const bandProps = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4, contentRows: 1 }, view: {} } as never
  const band = await $.ui.mount({ plugin: 'claim', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: bandProps })
  expect(await band.find({ text: /1 in no file/ })).toBeDefined()
  expect(await band.find({ text: /not in file/ })).toBeUndefined()
  expect((await band.find({ key: 'red' }))?.props.label).toBe('$3,382.50')
  await band.unmount()
})

test('files a search turns up are checked too', async ($, on) => {
  mock.clock(on)
  const runs: string[][] = []
  const there = ['/work/src/app.py', '/work/docs/guide.md', '/work/claim/core.py']
  disk(on, path => there.includes(path))
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return scanned(e.argv)
  })
  on('tool.call', ($, e) => ({
    result: { stdout: String((e as { command?: string }).command).startsWith('rg') ? 'src/app.py:12:    retries = 3\ndocs/guide.md:40:Retries are capped\nsrc/app.py:30:x\n' : 'src/app.py\n', stderr: '', interrupted: false },
  }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  // A search names only a folder; its matches are in the output. ls lists files but reads none.
  await $.tool.call({ tool: 'Bash', command: 'rg -n retries src docs' })
  await $.tool.call({ tool: 'Bash', command: 'ls src' })
  await $.turn.complete({ turnId: 't1', durationMs: 1000, isAborted: false, reason: 'answer', answer: 'It says "Revenue tripled overnight after the board approved the new plan".' })
  expect(runs.map(scannedFiles)).toEqual([['/work/src/app.py', '/work/docs/guide.md']])
})

test('any text file counts, whatever its name; binary files and folders do not', async ($, on) => {
  mock.clock(on)
  const runs: string[][] = []
  disk(on, path => !path.endsWith('gone.css'))
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return scanned(e.argv)
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  for (const file of ['/work/styles/site.css', '/work/Makefile', '/work/App.swift', '/work/tool.bin', '/work/gone.css']) {
    await $.tool.call({ tool: 'Read', file_path: file })
  }
  await $.turn.complete({ turnId: 't1', durationMs: 1000, isAborted: false, reason: 'answer', answer: 'It says "Revenue tripled overnight after the board approved the new plan".' })
  expect(runs.map(scannedFiles)).toEqual([['/work/App.swift', '/work/Makefile', '/work/styles/site.css']])
})

test('a PDF card in the terminal has the page\'s lines under its picture; a text card has no picture', async ($, on) => {
  mock.clock(on)
  disk(on)
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  const page = {
    status: 'exact', page: 2, path: '/docs/paper.pdf', sha256: '9a1f00c2d4e5b6a7', matched: 'We observe a 12% improvement', crop: '/tmp/claim-8.png',
    lines: [41, 42], excerpt: [[40, 'explains how quickly training converges in most'], [41, 'settings. We observe a 12% improvement over the'], [42, 'baseline when the retrieval step is enabled. The'], [43, 'validation split explains the number']],
  }
  on('process.run', ($, e) => ({
    value: { exitCode: 0, stdout: JSON.stringify(e.argv.at(-2) === 'paper.pdf' ? page : TEXT_AND_TABLE["we'll ship the beta on 14 March"]), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', () => ({ result: 'ok' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__claim__claim', file: 'notes.md', quote: "we'll ship the beta on 14 March" })
  await $.tool.call({ tool: 'mcp__claim__claim', file: 'paper.pdf', quote: 'We observe a 12% improvement' })

  const paneProps = { title: 'claim', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30, contentRows: 30 }, view: {} } as never
  const pane = await $.ui.mount({ plugin: 'claim', surface: 'terminal', component: 'Pane', requestId: 'claim', props: paneProps })
  // The PDF: picture, then the page's lines, the hit lines tinted; the card still says page, never line.
  expect(await pane.find({ type: 'Image' })).toBeDefined()
  expect(await pane.find({ text: /paper\.pdf · page 2$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /paper\.pdf · lines? \d/ })).toBeUndefined()
  expect((await pane.find({ type: 'Text', text: /^settings\. We observe a 12% improvement/ }))?.props.backgroundColor).toBe('diffAdded')
  expect((await pane.find({ type: 'Text', text: /^explains how quickly/ }))?.props.backgroundColor).toBeUndefined()
  // The markdown file: its lines and no picture, as before.
  await pane.press({ key: 'row-1' })
  expect(await pane.find({ text: /notes\.md · line 48/ })).toBeDefined()
  expect(await pane.find({ type: 'Image' })).toBeUndefined()
  await pane.press({ key: 'row-0' })
  await pane.unmount()

  // Nothing is red, so the band names nothing.
  const band = await $.ui.mount({ plugin: 'claim', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4, contentRows: 1 }, view: {} } as never })
  expect(await band.find({ text: /2 in file/ })).toBeDefined()
  expect(await band.find({ key: 'red' })).toBeUndefined()
  expect(await band.find({ text: /: / })).toBeUndefined()
  await band.unmount()

  // Desktop keeps the picture alone.
  const desk = await $.ui.mount({ plugin: 'claim', surface: 'desktop', component: 'Pane', requestId: 'claim', props: paneProps })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  expect(await desk.find({ text: /^settings\. We observe/ })).toBeUndefined()
  await desk.unmount()
})

test('a place a claim call already showed is not shown again by the scan; other places are', async ($, on) => {
  mock.clock(on)
  disk(on)
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  const sheet = (row: number, cells: number[]) => ({ header: ['Item', 'Amount'], rows: [['Hotel', '$1,234.50']], numbers: [row], hit: 0, cells })
  const hotel = { status: 'exact', page: 1, path: '/work/costs.xlsx', sha256: 'aa', matched: 'Hotel · 1,234.50', lines: null, crop: null, sheet: 'Q3', excerpt: sheet(18, [0, 1]) }
  on('process.run', ($, e) => {
    if (!e.argv.includes('claim-scan')) return { value: { exitCode: 0, stdout: JSON.stringify(hotel), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const out = [
      { ...hotel, matched: '1,234.50', quote: '$1,234.50', kind: 'figure', excerpt: sheet(18, [1]) },          // the same cell: dropped
      { ...hotel, matched: '1,234.50', quote: '$1,234.50', kind: 'figure', excerpt: sheet(31, [1]), places: 2 }, // another row: kept
      { ...hotel, sheet: 'Q4', matched: '1,234.50', quote: '1234.5', kind: 'figure', excerpt: sheet(18, [1]) },  // another sheet: kept
      { status: 'not found', page: null, path: '', sha256: null, matched: null, lines: null, crop: null, excerpt: null, quote: '$3,385.00', kind: 'figure' },  // no place: kept
    ]
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', ($, e) => ({ text: e.text, turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Text, {}, 'engine') as RenderElement)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'what did travel cost?', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/work/costs.xlsx' })
  await $.tool.call({ tool: 'mcp__claim__claim', file: '/work/costs.xlsx', quote: 'Hotel 1,234.50' })
  await $.turn.complete({ turnId: 't1', durationMs: 1000, isAborted: false, reason: 'answer', answer: 'Hotel was $1,234.50; the total is $3,385.00.' })
  const bandProps = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4, contentRows: 1 }, view: {} } as never
  const band = await $.ui.mount({ plugin: 'claim', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: bandProps })
  expect(await band.find({ text: /3 in file/ })).toBeDefined()  // the call's card, row 31, and the Q4 sheet
  expect(await band.find({ text: /1 in no file/ })).toBeDefined()
  await band.unmount()

  // A second answer: the band counts it alone, not the first answer's records on top.
  await $.turn.start({ text: 'and the hotel?', turnId: 't2' } as never)
  await $.tool.call({ tool: 'mcp__claim__claim', file: '/work/costs.xlsx', quote: 'Hotel 1,234.50' })
  const again = await $.ui.mount({ plugin: 'claim', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: bandProps })
  expect(await again.find({ text: /1 in file/ })).toBeDefined()
  expect(await again.find({ text: /in no file/ })).toBeUndefined()
  await again.unmount()

  // A third prompt with no claim call and nothing scanned: no band, so an earlier answer's counts never pass for this one's.
  await $.turn.start({ text: 'thanks', turnId: 't3' } as never)
  const quiet = await $.ui.mount({ plugin: 'claim', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: bandProps })
  expect(await quiet.find({ text: 'engine' })).toBeDefined()
  expect(await quiet.find({ text: /in file/ })).toBeUndefined()
  await quiet.unmount()
})

test('a claim call takes the record claim\'s server left for it, and runs claim itself only when there is none', async ($, on) => {
  const clock = mock.clock(on)
  const runs: string[][] = []
  const left = { status: 'exact', page: 2, path: '/work/report.pdf', sha256: 'cc', matched: 'margins stay stable', lines: [7, 7], excerpt: null, crop: '/tmp/x.png', crop1x: '/tmp/x-1x.png', size: [600, 200] }
  on('env.get', ($, e) => ({ value: e.name === 'TMPDIR' ? '/var/T/' : undefined }) as never)
  on('fs.stat', ($, e) => {
    if (e.path.startsWith('/var/T/claim/call-')) return { value: { kind: 'file' as const, size: 10, mtimeMs: e.path.endsWith(HANDED) ? 9e15 : 0, isLink: false } }  // 9e15: written after any time the clock says
    return { value: { kind: 'file' as const, size: 100, mtimeMs: 0, isLink: false } }
  })
  on('fs.exists', () => ({ value: true }))
  on('fs.read', ($, e) => ({ value: e.path.startsWith('/var/T/claim/call-') ? JSON.stringify(left) : e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify({ ...left, matched: 'ran itself' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  // The server left a file for this call (its name is the sha256 of the call), written just now: no process runs.
  await $.tool.call({ tool: 'mcp__claim__claim', file: '/work/report.pdf', quote: 'margins stay stable', page: 2 })
  expect(runs).toHaveLength(0)
  // A day later, another call whose file is an old one from an earlier session: claim runs itself.
  await clock.advance(86_400_000)
  await $.tool.call({ tool: 'mcp__claim__claim', file: '/work/report.pdf', quote: 'something else' })
  expect(runs).toHaveLength(1)
})
// The sha256 of ["/work/report.pdf","margins stay stable",2], as the server names its file.
const HANDED = '5215e2296656c9eac637462867c12b9cacbec3bc87b48b58a25f12a38938a948.json'

test('each claim call shows its card right under it in the conversation, and one press anywhere on the band opens the pane', async ($, on) => {
  mock.clock(on)
  disk(on)
  const opened: string[] = []
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? bytes(e.path) : 'Call claim.' }))
  on('process.run', ($, e) => ({
    value: { exitCode: 0, stdout: JSON.stringify(TEXT_AND_TABLE[e.argv.at(-1) ?? '']), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.open', ($, e) => { opened.push(e.id); return { value: { isPlaced: true as const } } })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine') as RenderElement
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__claim__claim', tool_use_id: 'call-1', file: 'cities.csv', quote: 'host of the 2031 regional games' } as never)

  const result = (id: string) => ({ plugin: 'claim', surface: 'terminal', component: 'ToolResult', requestId: id, viewport: { columns: 90, rows: 40 },
    props: { tool_use_id: id, tool: 'mcp__claim__claim', output: 'the picture for the model', isErrored: false } }) as never
  // Under the call: its own card, with the cell in words and the grid around it; not the engine's drawing.
  const under = await $.ui.mount(result('call-1'))
  expect(await under.find({ text: /^Partly in the file$/ })).toBeDefined()
  expect(await under.find({ text: 'Malmo › note = host of the 2031 regional games' })).toBeDefined()
  expect(await under.find({ text: 'engine' })).toBeUndefined()
  await under.unmount()
  // A call claim has no record for (another tool's, or one still running) keeps the engine's drawing.
  const other = await $.ui.mount(result('call-2'))
  expect(await other.find({ text: 'engine' })).toBeDefined()
  await other.unmount()
  // Folded into a group line (`called claim 2 times, ran 1 shell command`): the line, then the claim call's card under it.
  const call = (id: string, tool: string) => ({ tool_use_id: id, tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: '' })
  const group = (isExpanded: boolean) => ({ plugin: 'claim', surface: 'terminal', component: 'ToolGroup', requestId: 'g', viewport: { columns: 90, rows: 40 },
    props: { calls: [call('b-1', 'Bash'), call('call-1', 'mcp__claim__claim'), call('call-2', 'mcp__claim__claim')], isActive: false, isExpanded } }) as never
  const folded = await $.ui.mount(group(false))
  expect(await folded.find({ text: 'engine' })).toBeDefined()
  expect(await folded.find({ text: 'Malmo › note = host of the 2031 regional games' })).toBeDefined()
  await folded.unmount()
  // Unfolded, each row has its own ToolResult, so the group adds nothing.
  const unfolded_ = await $.ui.mount(group(true))
  expect(await unfolded_.find({ text: 'Malmo › note = host of the 2031 regional games' })).toBeUndefined()
  await unfolded_.unmount()

  // The band: "claim", the count and "open" each open the pane in one press.
  const bandProps = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4, contentRows: 1 }, view: {} } as never
  const band = await $.ui.mount({ plugin: 'claim', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: bandProps })
  for (const key of ['open', 'claim', 'count-partial']) await band.press({ key })  // "open" first: once open it reads "esc close"
  expect(opened).toEqual(['claim', 'claim', 'claim'])
  await band.unmount()
})
