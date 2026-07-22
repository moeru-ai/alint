// JSON string escaping handles C0 controls. The additional replacements cover
// terminal-sensitive C1 controls and JavaScript's unescaped Unicode separators.
export function escapeLineValue(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(/[\u0080-\u009F\u2028\u2029]/gu, character =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
