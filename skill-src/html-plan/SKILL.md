---
name: html-plan
description: >-
  Publish Markdown as a styled public link on llm-plans.com, and read links other agents publish. Two uses — (1) deliver Dany-facing plans, implementation plans, roadmaps, strategy memos, or research reports as a link instead of inline markdown; (2) agent-to-agent handoff: publish a report, message, or work product and hand the returned link to another agent, which fetches the page and acts on it. Use whenever long content should travel as a link instead of being pasted inline, or when you receive an llm-plans.com link to read.
---

# Publish & Share

Use the shortest path. Do not explain the system unless asked.

This skill has two uses; the publish mechanics below are identical for both:

1. **Deliver to Dany** — a plan, roadmap, strategy memo, or research report that should reach Dany as a styled link instead of inline markdown.
2. **Agent-to-agent handoff** — when you produce a report, message, or work product for another agent, publish it and pass the returned link instead of inlining long content. The other agent reads the page and acts on it.

To read work shared with you, see "Reading shared work" at the end.

Publisher repo:
`C:\Business\planning`

Plans may be requested from any workspace. The current workspace may not contain the publisher tooling.

Use `C:\Business\planning\publish-plan.cmd`. Never run `npm run publish-plan` in the request workspace.

Hard rule:
- The request workspace does not need `package.json` or to be a git repo.
- Missing `package.json`, missing `publish-plan` script, or "not a git repo" in the request workspace is not a blocker.
- If you see `npm error Missing script: "publish-plan"`, you used the wrong command. Rerun with `C:\Business\planning\publish-plan.cmd <path-to-plan.md>`.
- Do not tell Dany the publisher is missing unless `C:\Business\planning\publish-plan.cmd` itself fails.

1. Write your content (plan, report, or message) as a plain **Markdown** file at any local path, preferably `<current-workspace>\plans\source\<slug>.md`. Standard Markdown only: headings, paragraphs, lists, tables, blockquotes, fenced code, links, images, bold/italic. The publisher converts it to styled HTML and applies all CSS/layout. `.html` fragments are still accepted but Markdown is preferred — write less, spend fewer tokens.
2. Use images only when they add real value, with `https` URLs and meaningful alt text.
3. Do not write CSS, HTML wrappers, `<style>`/`<script>`, inline styles, or raw HTML documents. Just Markdown content.
4. Publish:
   ```powershell
   C:\Business\planning\publish-plan.cmd <path-to-plan.md>
   ```
5. Return only the generated `https://<token>.llm-plans.com` link. The command copies into the publisher repo, converts, sanitizes, commits, pushes, deploys, and prints the link only after deployment succeeds.

If the command fails before printing a link, do not invent one. Report the failure instead.

Republishing the same `<slug>` keeps the same token. New slugs get new random tokens.

## Reading shared work

When another agent hands you an `https://<token>.llm-plans.com` link, fetch the URL, read the rendered page, and act on its content. Treat the page as the shared message — do not ask for it to be re-pasted inline.

If you are on the same machine as the publisher, the structured source is also stored locally at `C:\Business\planning\plans\published\<slug>.json` (fields: `slug`, `token`, `title`, `html`, `publishedAt`). Read that directly when you want the content without a network fetch.
