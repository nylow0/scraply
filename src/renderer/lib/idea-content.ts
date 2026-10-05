/** Saved descriptions use either "Name: description" or the older "Name. description". */
export function ideaContent(description: string): { name: string; summary: string } {
  const text = description.trim();
  const colon = text.match(/^([^\n:]{1,160}):\s+/);
  const sentence = text.match(/^(.+?[.!?])(?:\s+|$)/);
  const title = colon && (!sentence || colon[0].length < sentence[0].length) ? colon : sentence;
  const lead = title?.[1] ?? text.split("\n")[0] ?? "";
  const name = lead.trim().replace(/[.!?]+$/, "");
  return { name, summary: text.slice(title?.[0].length ?? lead.length).trim() };
}

/** Keep ambiguous prose intact. Newlines take precedence over sentence boundaries. */
export function mechanismSteps(mechanism: string): string[] | null {
  const text = mechanism.trim();
  if (!text) return null;
  const lines = text.split(/\r?\n+/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 1) return lines.length >= 3 ? lines.map(line => line.replace(/^\d+[.)]\s+/, "")) : null;
  const parts: string[] = [];
  let start = 0;
  const boundaries = /[.!?](?=\s+[A-Z]|$)/g;
  for (const match of text.matchAll(boundaries)) {
    const end = match.index + 1;
    const fragment = text.slice(start, end);
    if (/(?:\b(?:e\.g|i\.e|etc|Mr|Mrs|Ms|Dr|Prof|vs|Fig|No|St)|\b[A-Z])\.$/i.test(fragment)) continue;
    parts.push(fragment.trim());
    start = end;
  }
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts.length >= 3 ? parts : null;
}

export const EXPLAIN_IDEA_PROMPT = "Explain this idea to someone new to the field. Say what it is, who uses it, how it works step by step, and what would have to be true for it to work. Use short plain sentences.";
