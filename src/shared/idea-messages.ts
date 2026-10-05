export const EXPLAIN_IDEA_PROMPT = "Explain this idea to someone new to the field. Say what it is, who uses it, how it works step by step, and what would have to be true for it to work. Use short plain sentences.";

/** Keep the saved request intact while showing the same action in the UI and exports. */
export function visibleIdeaMessage(intent: string, userText: string): string {
  return intent === "explain" && userText === EXPLAIN_IDEA_PROMPT ? "Explain this idea" : userText;
}
