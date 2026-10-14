// The card: what one record looks like, wherever it is drawn (under the claim call in the
// conversation, or in the pane). register.tsx decides where; this file decides how. Nothing here
// touches the engine (the engine doesn't let `$` cross an import), so it is plain drawing.
import type { Elements } from 'claude-code'

import type { ClaimRecord, TableExcerpt } from '../types'

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

// How each of core's statuses looks: the card's word, the band's count word, the dot and its colour.
// The words say where the text is, not that the answer is right: "In the file" proves the
// words are there, not that the claim built on them holds.
// A figure in no file has its own look, not red: it may be a sum worked out right, so red stays
// for a quote that is not in its file, and a red dot keeps meaning "don't rely on it".
export const LOOK = {
  exact: { word: 'In the file', count: 'in file', color: 'success', dot: '●' },
  partial: { word: 'Partly in the file', count: 'partly', color: 'warning', dot: '●' },
  'not found': { word: 'Not in the file', count: 'not in file', color: 'error', dot: '●' },
  'no file': { word: 'In no file', count: 'in no file', color: 'warning', dot: '○' },
  'not searchable': { word: 'Not searchable', count: 'not searchable', color: 'inactive', dot: '●' },
  error: { word: 'claim could not run', count: 'could not run', color: 'inactive', dot: '●' },
} as const
export type Look = keyof typeof LOOK

// Which look a record gets: its status, except a figure found in no file.
export function look(r: ClaimRecord): Look {
  return r.kind === 'figure' && r.status === 'not found' ? 'no file' : r.status
}

const HELP = {
  exact: null,
  partial: null,  // the amber highlight says it: only that part is in the file
  'not found': "This quote is not in the file. Don't rely on it.",
  // A figure (a sum, an average) can be right without being in any file; the card says to check its sources.
  // The scan looks in the ten files read most recently, so a figure from an older one is reported this way too.
  'no file': 'This figure is in none of the files checked (the ten read most recently). If it was computed, check the rows it rests on.',
  'not searchable': 'Images have no text to search.',
  error: null,
} as const

// The card, top to bottom: a status line (dot, word, where, `enlarge` when there is a picture, the
// file's fingerprint), for something online a link that opens it at the quote, then what shows the
// hit: a text file's numbered lines, a table's rows, else `picture`, which register.tsx makes (it
// needs the engine to open the file). Nothing is repeated under it. A quote that wasn't found has
// nothing to show, so its card is the quote as the model wrote it and a help line instead.
// `enlarge` opens the picture full size: a terminal picture can't be clicked.
export function card(ui: Ui, r: ClaimRecord, width: number, picture: JSX.Element | null, enlarge?: () => void) {
  const { Box, Text, Button } = ui
  const help = r.status === 'error' ? r.error : HELP[look(r)]
  const table = r.excerpt && !Array.isArray(r.excerpt) ? r.excerpt : null
  const lines = r.lines && Array.isArray(r.excerpt) && !onPage(r) ? textLines(ui, r, r.lines, r.excerpt, width) : null
  const found = r.status === 'exact' || r.status === 'partial'
  const excerpt = lines ?? (table ? tableRows(ui, r, table, width) : found || r.status === 'not searchable' ? picture : null)
  const zoom = enlarge && picture && excerpt === picture
  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Text>
          <Text color={LOOK[look(r)].color}>{LOOK[look(r)].dot}</Text> <Text bold>{LOOK[look(r)].word}</Text>
          <Text dimColor>  {where(r)}</Text>
        </Text>
        <Box>
          {zoom ? <Button key={`enlarge-${r.crop}`} plain dimColor label="enlarge" onPress={enlarge} /> : null}
          <Text dimColor>{zoom ? '  ' : ''}{isWeb(r.path) ? 'web' : (r.sha256 ?? '').slice(0, 8)}</Text>
        </Box>
      </Box>
      {r.link ? <Text dimColor>{r.link}</Text> : null}
      {excerpt}
      {found && excerpt ? null : <Text dimColor>“{r.quote}”</Text>}
      {help ? <Text color={look(r) === 'not found' ? 'error' : undefined}>{help}</Text> : null}
    </Box>
  )
}

// The matched lines' background: the theme's own green row for found, amber
// (with the theme's contrasting text) for partly found.
function tint(status: ClaimRecord['status']) {
  return status === 'exact' ? { backgroundColor: 'diffAdded' } : { backgroundColor: 'warning', color: 'inverseText' }
}

// Text, code and markdown: each excerpt line under its line number. The
// matched lines are tinted and wrap so they are read whole; the lines around
// them are cut at the pane's edge.
export function textLines({ Box, Text }: Ui, r: ClaimRecord, lines: [number, number], excerpt: [number, string][], width: number) {
  const wide = String(excerpt.at(-1)?.[0] ?? '').length
  return (
    <Box flexDirection="column" width={width}>
      {excerpt.map(([n, text]) => {
        const hit = n >= lines[0] && n <= lines[1]
        return (
          <Box width={width}>
            <Text dimColor>{String(n).padStart(wide)}  </Text>
            <Box flexShrink={1}>
              {hit ? <Text {...tint(r.status)} wrap="wrap">{text || ' '}</Text> : <Text wrap="truncate-end">{text || ' '}</Text>}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

// Tables, drawn like a spreadsheet around the match: the row's first column (its label), `…` for
// the columns skipped, then the matched columns with one neighbour each side, so the matched cell
// is on screen however far right it is. The matched cells are filled, their column letters and the
// row's number coloured, the row banded. A line above says it in words: label › column = value.
// With no single matched cell (the whole row matched), the columns run from A and are cut at the edge.
export function tableRows({ Box, Text }: Ui, r: ClaimRecord, table: TableExcerpt, width: number) {
  const all = [table.header, ...table.rows]
  const count = Math.max(...all.map(row => row.length))
  const cells = table.hit === null ? [] : table.cells
  const near = cells.length ? range(Math.min(...cells) - 1, Math.max(...cells) + 1) : range(0, count - 1)
  const cols = [...new Set([0, ...near])].filter(c => c >= 0 && c < count).sort((a, b) => a - b)
  const sizes = cols.map(c => Math.min(24, Math.max(letter(c).length, ...all.map(row => flat(row[c]).length))))
  const wide = Math.max(...table.numbers.map(n => String(n).length))
  const room = Math.max(1, width - wide - 2)
  const color = r.status === 'exact' ? 'success' : 'warning'
  // One line of the grid as pieces of [text, style]: a cell is padded to its column's width, and
  // a jump over columns shows as `…`. Cut at the pane's edge.
  const line = (texts: string[], style: (i: number) => object | null) => {
    const pieces: [string, object | null][] = cols.flatMap((c, i) => {
      const gap: [string, object | null] = [i === 0 ? '' : c - (cols[i - 1] ?? c) > 1 ? '  …  ' : '  ', { dimColor: true }]
      return [gap, [clip(texts[i] ?? '', sizes[i] ?? 0).padEnd(i === cols.length - 1 ? 0 : sizes[i] ?? 0), style(c)]]
    })
    let left = room
    return pieces.map(([text, s]) => {
      const shown = left > 0 ? clip(text, left) : ''
      left -= shown.length
      return s ? <Text {...s}>{shown}</Text> : shown
    })
  }
  const hitRow = table.hit === null ? null : table.rows[table.hit] ?? null
  const named = hitRow ? cells.find(c => c !== 0) : undefined
  return (
    <Box flexDirection="column" width={width}>
      {hitRow && named !== undefined ? (
        <Text>
          <Text bold>{flat(hitRow[0])}</Text> <Text dimColor>›</Text> <Text bold>{flat(table.header[named]) || letter(named)}</Text>{' '}
          <Text dimColor>=</Text> <Text color={color} bold>{flat(hitRow[named])}</Text>
        </Text>
      ) : null}
      <Text>{' '.repeat(wide + 2)}{line(cols.map(letter), c => (cells.includes(c) ? { color, bold: true } : { dimColor: true }))}</Text>
      <Text dimColor>{' '.repeat(wide + 2)}{line(cols.map(c => flat(table.header[c])), () => null)}</Text>
      {table.rows.map((row, i) => {
        const hit = i === table.hit
        const band = hit && r.status === 'exact' ? { backgroundColor: 'diffAddedDimmed' } : null
        return (
          <Text>
            <Text {...(hit ? { color, bold: true } : { dimColor: true })}>{String(table.numbers[i] ?? '').padStart(wide)}  </Text>
            {line(cols.map(c => flat(row[c])), c => (!hit ? null : cells.length === 0 || cells.includes(c) ? tint(r.status) : band))}
          </Text>
        )
      })}
    </Box>
  )
}

// An answer's counts, after its heading: a dot and a count per status.
export function answerCounts({ Text }: Pick<Ui, 'Text'>, group: ClaimRecord[]) {
  const present = (Object.keys(LOOK) as Look[]).filter(s => group.some(r => look(r) === s))
  return (
    <Text dimColor>
      {present.map(status => (
        <Text>
          {' · '}
          <Text color={LOOK[status].color}>{LOOK[status].dot}</Text> {group.filter(r => look(r) === status).length} {LOOK[status].count}
        </Text>
      ))}
    </Text>
  )
}

// How long ago, the way the pane says it.
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// Where the record is, in a few words: file, sheet, then the line, cell, row or page.
export function where(r: ClaimRecord): string {
  if (!r.path) return 'in none of the files checked'  // a figure the scan found in no file names no file
  const parts = [name(r.path)]
  if (r.sheet) parts.push(`sheet ${r.sheet}`)
  const table = r.excerpt && !Array.isArray(r.excerpt) ? r.excerpt : null
  if (r.lines && !onPage(r)) parts.push(r.lines[0] === r.lines[1] ? `line ${r.lines[0]}` : `lines ${r.lines[0]}–${r.lines[1]}`)
  else if (table && table.hit !== null) parts.push(cellName(table) ? `cell ${cellName(table)}` : `row ${table.numbers[table.hit]}`)
  else if (r.page && !isWeb(r.path)) parts.push(`page ${r.page}`)
  // A figure that turns up in many places is lit where it first does, which may not be the one meant.
  if ((r.places ?? 1) > 1) parts.push(`1 of ${r.places} places`)
  return parts.join(' · ')
}

// A record's place on its line in the pane: for a spreadsheet cell in words and by name
// (`Hotel › Amount · D18`), else the file and its line, cell, row or page.
export function spot(r: ClaimRecord): string {
  const table = r.excerpt && !Array.isArray(r.excerpt) ? r.excerpt : null
  const row = table && table.hit !== null ? table.rows[table.hit] : null
  const c = table?.cells.find(x => x !== 0)
  if (!table || !row || c === undefined) return where(r)
  const places = (r.places ?? 1) > 1 ? ` · 1 of ${r.places} places` : ''
  return `${flat(row[0])} › ${flat(table.header[c]) || letter(c)} · ${cellName(table)}${places}`
}

// A column's spreadsheet name: 0 is A, 25 is Z, 26 is AA.
export function letter(c: number): string {
  return (c >= 26 ? letter(Math.floor(c / 26) - 1) : '') + String.fromCharCode(65 + (c % 26))
}

// Where the match is, as a spreadsheet would say it: D18, or B13:D13 across cells.
export function cellName(table: TableExcerpt): string | null {
  const cells = table.cells ?? []
  if (table.hit === null || cells.length === 0) return null
  const row = table.numbers[table.hit]
  const first = `${letter(Math.min(...cells))}${row}`
  return cells.length === 1 ? first : `${first}:${letter(Math.max(...cells))}${row}`
}

// A file's name, or for a web page its host and last path segment.
export function name(path: string): string {
  if (!isWeb(path)) return path.split('/').pop() ?? path
  const url = new URL(path)
  const last = url.pathname.split('/').filter(Boolean).pop()
  return last ? `${url.host}/${last}` : url.host
}

export function isWeb(path: string): boolean {
  return /^https?:\/\//.test(path)
}

// A record whose lines are a page's, not a file's: a PDF, a web page, a PDF online.
export function onPage(r: ClaimRecord): boolean {
  return isWeb(r.path) || /\.pdf$/i.test(r.path)
}

export function shorten(text: string, room: number): string {
  const flat_ = text.replace(/\s+/g, ' ')
  return flat_.length <= room ? flat_ : `${flat_.slice(0, Math.max(1, room - 1)).trimEnd()}…`
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i)
}

function flat(cell: string | undefined): string {
  return String(cell ?? '').replace(/\s+/g, ' ')
}

function clip(text: string, room: number): string {
  return text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`
}
