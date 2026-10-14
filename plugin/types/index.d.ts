// What the claim plugin keeps in $.state for the session.

// One run of `claim ... --json`, kept as it came back, plus the quote asked
// about and when. `status` is core's word, or 'error' when claim could not run.
export type ClaimRecord = {
  status: 'exact' | 'partial' | 'not found' | 'not searchable' | 'error'
  path: string
  sha256: string | null
  page: number | null
  // text sources: the first and last matched line of the file; a PDF (or web page): of the page, counted from its top
  lines: [number, number] | null
  matched: string | null
  quote: string
  crop: string | null
  // the same picture at half size, for surfaces that carry it inside an SVG
  crop1x: string | null
  // crop1x's width and height in pixels (the full crop is twice that), so drawing needn't open the file
  size: [number, number] | null
  // text sources: [[line_number, text], ...] from the file; a PDF (or web page): the same shape, the page's
  // lines with one either side of the hit; tables: TableExcerpt; else null
  excerpt: [number, string][] | TableExcerpt | null
  // the spreadsheet tab the quote was looked for on; null for anything else
  sheet: string | null
  // for a web page or an online PDF: a link that opens it at the quote (or its page); else null
  link: string | null
  time: number
  // 'tool' when a claim tool call asked for it, 'turn' when the plugin found
  // the quote in the assistant's answer at the end of a turn and checked it itself
  source: 'tool' | 'turn'
  // the id of the answer (turn) the record belongs to; the pane groups by it
  turn: string
  // for a claim tool call: the call's tool_use_id, so its card is drawn under it in the conversation
  call?: string
  // what was checked: a passage, or a figure (a number with a currency or percent sign, a decimal point, a comma, or four or more digits, a year aside)
  kind: 'quote' | 'figure'
  // a figure from the scan: how many pages or rows of the files read hold it (the card shows "1 of N places");
  // 1 for anything else, 0 for a figure in no file
  places?: number
  // a figure in no file: the answer's other figures in its sentence or table row, each with where a file
  // holds it (`p.75`, `cities.csv`), or null for one in no file either
  near?: { quote: string, where: string | null }[]
  // a figure written short ($284.7B) that a file holds in full: the file's own spelling (284,668)
  rounded?: string
  // only for status 'error': the first line claim printed to stderr
  error?: string
}

// The rows a table record shows, with the file's row numbers and which one hit.
export type TableExcerpt = {
  header: string[]
  rows: string[][]
  numbers: number[]
  // null when none of the shown rows holds the match
  hit: number | null
  // the columns (0 is A) of the hit row's cells that hold the match; empty when none
  cells: number[]
}

declare module 'claude-code' {
  interface PluginState {
    claim: {
      // newest first
      records: ClaimRecord[]
      // which record's card is open in the pane, as its index in records; -1 is the newest answer's first problem, -2 none
      selected: number
      // the last answers' text, newest first, at most 20: cards go under their answer, and the pane follows its order
      answers: { turn: string; text: string }[]
      // the lines under an answer the person opened or closed, against the default (its first problem open)
      flipped: string[]
      // whether the pane is open, so the band's hint can say "esc close"
      isOpen: boolean
      // the files this session has read (Read, claim tool calls, @ attachments), newest first, at most 50
      files: string[]
      // the files the session really opened (Read, @, an approved claim call); a claim call on one of these needs no permission prompt
      opened: string[]
      // the id of the answer being written right now
      turn: string
      // the earlier answers unfolded in the pane, by turn id
      unfolded: string[]
    }
  }
}
