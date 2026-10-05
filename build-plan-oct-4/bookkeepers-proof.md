# Bookkeepers proof run

Run 19 used the installed production app from `0b9c030`, GPT-6.1 Sol high, Standard research, all selected problems, and three ideas per problem. It finished with `target-met` in 36.4 minutes. Five problems produced exactly five writing calls, five ranking calls, and 15 saved ideas. All groups have ranks 1, 2, and 3 with reasons. None received a weak-fit flag.

Session ID: `957825c6-d9e3-45b8-a496-d2da2efcd6ae`.

The trace reports 279 model calls and 96 dispatched searches. Run details displays 114 search budget units. Five model attempts were interrupted by provider response failures; all work items ultimately succeeded. No idea review, novelty-search, or fill stage ran.

## Ranked ideas

| Problem group | Rank | Idea | What it does |
| --- | --- | --- | --- |
| Duplicate transactions after imports or feed transitions | 1 | Statement Proof Review | Compares bank activity with ledger occurrences and creates a read-only duplicate review list. |
| Duplicate transactions after imports or feed transitions | 2 | Migration Delta Checkpoint | Records the migrated ledger and highlights later additions that may repeat existing history. |
| Duplicate transactions after imports or feed transitions | 3 | Import Coverage Manifest | Tracks individual covered transactions and unresolved gaps across repeated imports. |
| Missing historical transactions | 1 | Missing-Only Import Guard | Produces a reviewed missing-only upload file with explanations for withheld rows. |
| Missing historical transactions | 2 | Recovery Coverage Checkpoint | Tracks which rows remain absent, await categorization, or have been verified after reconnects. |
| Missing historical transactions | 3 | Historical Archive Assembler | Combines available files and statements into a traceable import pack. |
| Restoring missing client transaction history | 1 | History Source Stitcher | Assembles older bank files, statements, and accounting exports month by month. |
| Restoring missing client transaction history | 2 | Missing-Only Recovery Pack | Separates absent bank rows from existing or ambiguous records before import. |
| Restoring missing client transaction history | 3 | Recovery History Vault | Archives periodic bank files and checks coverage after reconnecting a feed. |
| Duplicates across migrations, historical data, and live feeds | 1 | Migration Recovery Map | Maps confirmed extra records to native correction paths and flags linked-record risks. |
| Duplicates across migrations, historical data, and live feeds | 2 | Statement Count Review | Counts real bank occurrences separately from similar ledger records. |
| Duplicates across migrations, historical data, and live feeds | 3 | Import Overlap Gate | Separates import-ready rows from overlaps and records later feed downloads. |
| Missing client explanations and usable documents | 1 | Purpose Context Cards | Carries approved client explanations into later bookkeeping reviews. |
| Missing client explanations and usable documents | 2 | Fresh Context Cadence | Configures weekly transaction questions to capture context before month-end. |
| Missing client explanations and usable documents | 3 | Accepted Data Checkpoint | Defines acceptance requirements for client answers and routes incomplete submissions back. |

## Result limits

The two duplicate-transaction groups overlap, as do the two missing-history groups. Their ideas repeat across groups. Ranking compares ideas within one problem, so it cannot remove repeats between research problems. The rank reasons are readable and explain the ordering, but several third-ranked ideas have weak incremental-value evidence without failing a must-have. Missing evidence remains unknown under the requested weak-fit rule.

The planned Science fair proof run remains conditional on Dany reviewing these results. The run budget has two runs left, one reserved for Science fair and one spare. No additional paid run was started during this handoff.
