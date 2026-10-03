# Completed-run report parity checklist

Authoritative reference: `simulator/src/report-renderer.js`. Fixture used for comparison: `evidence/tournaments/runs/sample-32-002`.

## Section and interaction mapping

| Offline report surface | Online equivalent | Data source / verification |
| --- | --- | --- |
| Report header and champion line | `ReportView` compact report header | Strict run detail projection; same run ID and champion; accepted offline report remains downloadable |
| Sticky one-line section navigation | `SectionNavigation` below the application header | Intersection-based active link, horizontal overflow, arrow/Home/End keyboard focus, corrected scroll offsets |
| Tournament outcome | `Summary` | Same five metrics and champion-series detail |
| Verification | `Verification` | Server-projected integrity facts; same banner, disclosure, metrics, and reproducibility boundary |
| Group standings | `Standings` | API-side group/search/cursor/page size; all ten columns, advancement fill, cutoff rule |
| Group tabs | `Standings` tablist | Roving tab index with ArrowLeft/ArrowRight/Home/End behavior |
| Knockout rounds | `Knockout` | Same champion summary, round tabs, expandable series, and nine-column per-game evidence |
| Round tabs | `Knockout` tablist | Roving tab index with ArrowLeft/ArrowRight/Home/End behavior |
| Battle explorer toolbar | `BattleExplorer` | Bounded API search, stage/result/hostname filters, page sizes, reset, count, cursors, and six sortable headings |
| Battle table and detail | `BattleExplorer` + `MatchDetail` | Split pane, keyboard-selectable rows, selected-row styling, all fifteen record fields, and copy controls |
| Result semantics | `formatOutcome` / `matchOutcome` | Canonical type and displayed result are `'win' | 'tie'`; tied-match UI regression verifies `tie` and `Draw` presentation |
| Pending replay | `MatchDetail` | One disabled `Watch replay` action with an explanatory label; no page-level action |
| Pod attribution | `PodAttribution` | Conditionally rendered; reuses the renderer-exported `aggregatePodAttribution` projection |
| Configuration and timing | First `RunDetails` disclosure | Canonical metadata and renderer-formatted wall-clock duration |
| Outcome and duration statistics | Second `RunDetails` disclosure | Server projection characterized against the offline renderer output |
| Slowest simulations | Third `RunDetails` disclosure | Same top-ten ordering and renderer-formatted durations |
| Methodology and limitations | Fourth `RunDetails` disclosure | Same artifact authority, ordering, scope, and operational-field limitations |
| Dark visual system | `styles.css` report-page rules | Renderer tokens, panels, metrics, disclosures, tables, tabs, selected rows, details, and 1000/700 px responsive breakpoints |

## Intentional online differences

- The compact application header adds `Back to all runs`; the offline file has no multi-run context.
- The header identifies the page as the completed-run explorer rather than an offline report.
- The browser requests bounded standings and battle pages from the read-only API. The offline file embeds all records and filters locally.
- The online methodology says that bounded network requests are made. The offline report remains self-contained and truthfully says it makes no network requests.
- Result and winner presentation passes through the shared typed formatter: canonical result terms remain `win` and `tie`, and a tied winner is displayed as `Draw`.
- The online battle detail contains the requested disabled replay placeholder. No replay data or viewer is implemented.
- Report CSS is reproduced in the React stylesheet instead of extracting the renderer's embedded CSS constant. A future consolidation can move tokens to a shared generated asset, but this correction deliberately avoids changing accepted offline output.

## Visual comparison protocol

Use `sample-32-002` and select the same battle in the desktop explorer comparison. The intended capture destinations are:

- `evidence/explorer-parity/offline-desktop-battle.png`
- `evidence/explorer-parity/online-desktop-battle.png`
- `evidence/explorer-parity/online-mobile-battle.png`

These images are not committed by this change. The temporary headless browser available during verification lacked required runtime libraries, and the additional download was declined; the code and automated parity checks do not claim that visual captures were completed.

The offline renderer, canonical artifacts, simulator behavior, runner behavior, and accepted Kubernetes baseline are not changed by this parity work.
