# Phase 3 usefulness evaluation

This procedure compares matching v1 and v2 discovery runs for the initial three-decision usefulness review. It tests whether the results help a reviewer choose an action. It does not itself accept a release.

Export research JSON plus ideas JSON and Markdown from each run. Start with:

```powershell
bun run evaluate:phase3 -- template <input.json>
```

Each case has two `{ ideasPath, ideasMarkdownPath, researchPath, origin, timings? }` variants. Prepare the blinded material:

```powershell
bun run evaluate:phase3 -- prepare <input.json> <output-directory>
```

Give the reviewer the generated `*-A.md` and `*-B.md` files, `review-packet.json` for source auditing, and a copy of `review-template.json`. Keep `private-mapping.json` separate. It contains workflow identity, provenance (`generated`, `synthetic`, or `live`), original and blinded hashes, run metadata, and optional timings.

The preparer removes only the `Workflow: v1.` or `Workflow: v2.` prefix from Markdown. It preserves the selection and problem-evidence assessment, so the different output structure may still reveal a version. After the reviewer records unsupported claims, useful discoveries, reading and correction time, and the action chosen, validate the results:

```powershell
bun run evaluate:phase3 -- validate <packet.json> <mapping.json> <reviews.json> <result.json>
```

Start with three cases and add up to two more if results are mixed. Validation checks complete, untampered records; it does not declare the Phase 3 gate accepted. Known-problem behavior needs separate testing because it does not produce the paired discovery research export.

Cases default to `comparison: "selected-problem"`, requiring matching problem statements and archived scopes. For independent discovery runs, set `comparison: "research-scope"`. The original nonempty research question and every archived constraint must match, though selected problems may differ. This compares the whole workflow, including which problem it discovers. Only the cosmetic research title is excluded from scope comparison and replaced with the question in the blinded packet. The original exports and hashes remain in the private mapping.
