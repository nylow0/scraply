const PLACEHOLDER_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * Look-alike text for a hidden value, the way T3 Code hides account emails. The placeholder keeps the
 * value's length and its `@ . - _` separators, so the blurred text still reads as "an email", but it
 * shares none of the other characters. The real value stays out of the DOM (and out of screenshots,
 * screen shares, and copied text) until the user reveals it. Seeding from the value keeps it stable.
 */
export function redactedPlaceholder(value: string): string {
  // FNV-1a hash of the value seeds a small xorshift-multiply generator.
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  const nextCharacter = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return PLACEHOLDER_ALPHABET[Math.abs(state) % PLACEHOLDER_ALPHABET.length] ?? "x";
  };
  return Array.from(value, (character) => "@.-_".includes(character) ? character : nextCharacter()).join("");
}
