---
name: claim
description: After citing or quoting a document, PDF, table, or file, call the
  claim tool to show the user the source page with the quote highlighted.
---
When you quote or cite a specific passage from a file the user gave you or
that you read, call `claim(file, quote, page)` with the passage as you wrote
it. Do this once per distinct citation, right after the claim it supports.
If the result says "not found", tell the user plainly that you could not
locate that exact passage.

This includes a row of a table or spreadsheet (.csv, .xlsx, .xls) that you
name or rely on, however you read it, scripts included. Pass the cell values
you use, as they appear in the file, for example `INV07021335 226548`; claim
finds them on one row even with other columns between them, on any tab. Leave
`page` out for spreadsheets. A figure you computed (a sum, an average) is not
in the file, so claim the row or rows it rests on instead, such as the top
entry you name.
