/**
 * Pure prompt assembly. The user fills every space in the UI; this module
 * concatenates them in fixed order and injects NOTHING. Empty spaces are
 * omitted. The only fixed text is the attachment fence required by the
 * delimited-source-material contract.
 */
export interface PromptAssembly {
  typeText: string;
  formatText: string;
  userText: string;
  styleText: string;
  attachedMarkdown?: string;
  attachedFileName?: string;
  /** Always-on global rules (PREFERENCES.md). Appended last so the layout
   *  trigger keeps line 1 and the hard rules land in the final read pass. */
  preferencesText?: string;
  /** Active skill text. A skill may carry layout, content and style at once,
   *  so it goes after everything and overrides the slots above it. */
  skillText?: string;
}

export function assemblePrompt(p: PromptAssembly): string {
  const sections: string[] = [];

  if (p.typeText.trim()) sections.push(p.typeText.trim());
  if (p.formatText.trim()) sections.push(p.formatText.trim());

  const content: string[] = [];
  if (p.attachedMarkdown && p.attachedMarkdown.trim()) {
    const name = p.attachedFileName || "attachment";
    content.push(
      `=== ATTACHED SOURCE REFERENCE MATERIAL (${name}) ===\n\`\`\`markdown\n${p.attachedMarkdown.trim()}\n\`\`\``
    );
  }
  if (p.userText.trim()) {
    content.push(`=== USER INSTRUCTIONS ===\n${p.userText.trim()}`);
  }
  if (content.length) sections.push(content.join("\n\n"));

  if (p.styleText.trim()) sections.push(p.styleText.trim());

  if (p.preferencesText && p.preferencesText.trim()) {
    sections.push(
      `=== GLOBAL PREFERENCES (ALWAYS APPLY — NOT CONTENT) ===\n${p.preferencesText.trim()}`
    );
  }

  if (p.skillText && p.skillText.trim()) sections.push(p.skillText.trim());

  return sections.join("\n\n");
}
