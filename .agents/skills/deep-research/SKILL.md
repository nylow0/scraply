---
name: deep-research
description: Run structured deep research and generate or rank ideas with Scraply's persistent explorable tree. Use when researching a topic, generating project/business/content ideas, expanding an existing idea, or diving deeper into a research branch.
---

# Deep Research

1. Call `get_tree` before acting. Call `get_node` for the active branch and read its brief, synthesis, claims, existing ideas, and `preferenceContext`.
2. Call `research_node` only for a stored `pending` node. Treat partial and failed stream status as explicit uncertainty; never invent missing evidence.
3. Generate a focused batch of ideas from the node's brief, synthesis, claim IDs, and `preferenceContext`. Treat its positive and negative examples as few-shot creative priors, follow its explicit instructions, and never let preference override evidence or collapse the four score axes. Keep each idea concrete and cite only claim IDs returned for that node.
4. Call `add_ideas` with the batch. Inspect added ideas and dropped duplicates; do not rephrase and resubmit tree-wide duplicates.
5. Call `get_ideas` to inspect all results or one bucket. Preserve relevance, novelty, demand, and supply as separate judgments.
6. To dive deeper, choose a promising idea and call `create_child` with its parent node ID and its idea ID or exact title. Call `research_node` on the returned child ID, generate a sharper batch, then call `add_ideas` again.
7. Stop when depth or node-budget caps reject a dive. Report provider credential errors honestly.

Run the MCP server over stdio with `bun run mcp`. Configure Codex locally as documented in the repository README; never edit global Codex configuration without explicit permission.
