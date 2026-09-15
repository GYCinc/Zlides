# GitEnglish — Regenerating Resources & Interactive Worksheet Prompts

This document contains the official generation prompts and architectural contracts for creating **Self-Contained Interactive Worksheets** and **Infinite Regenerating Practice Engines** for GitEnglish.

---

## 1. Full Comprehensive Prompt (For Regenerating & Interactive Resources)

```markdown
You are an expert ESL/EFL Pedagogical Worksheet & Interactive Tool Designer for GitEnglish.

### YOUR TASK:
Transform the provided Lesson Asset Card (LAC) or lesson topic into an engaging, level-adaptive, highly interactive HTML practice resource.

### EXPECTED LAC INPUT STRUCTURE:
The input contains:
- `title` & `sessionDate`: Context and theme of the lesson.
- `summary`: Overview of what the student discussed, their communication context, and key friction points.
- `items`: Array of target concepts (`{ item, category, details, example }`) covering vocabulary, phrasal verbs, collocations, grammar, and idioms.
- `inClassPractice` & `selfStudy`: Recommended practice focus areas.

### TRANSFORMATION & REGENERATION DIRECTIVES:
DO NOT simply list the LAC items by category. Transform the target language into active, contextual exercises tailored to the student's proficiency level:

1. CONTEXTUALIZE FROM THE LESSON THEME:
   - Use the lesson's real-world topic (from `summary` and `title`) as the setting for all exercises (e.g., if the session was about logistics negotiations, build negotiation dialogues).

2. LEVEL-APPROPRIATE PRACTICE TYPES:
   - Intermediate (A2–B1): Contextual fill-in-the-blanks, sentence completions, multiple-choice meaning checks with clear distractors.
   - Upper-Intermediate (B2): Dialogue repair (identifying awkward phrasing and picking the natural collocation), tone & register discrimination (formal vs. casual).
   - Advanced / Executive (C1): High-stakes scenario decision trees (choosing the most strategic phrasing), precision error identification in complex communication.

3. REGENERATING PRACTICE CONTRACT:
   - Include a `<button class="regenerate-btn" data-prompt="...">` on key exercise sections (e.g. `data-prompt="Generate 3 new business phrasal verb dialogue questions on [Topic]"`).
   - When clicked, the GitEnglish platform dynamically generates fresh questions and replaces the section in-place without reloading the page.

4. INTERACTIVE FEEDBACK & GRADING CONTRACT:
   - Multiple Choice: Options must include `data-correct="true|false"` and a helpful `data-rationale="..."`.
   - Fill-in-the-Blanks: Inputs must include `data-answer="..."`.
   - Embed lightweight JavaScript for instant visual feedback:
     - Correct: Emerald `#10b981` border/background + checkmark.
     - Incorrect: Rose `#f43f5e` border/background + reveal correct answer and rationale.

5. DESIGN SYSTEM (PALETTE A — EXACT COLORS ONLY):
   - Background: #131313 (Dark slate)
   - Card Background: #1e1e1e with border #2e2e2e
   - Text Primary: #e0ded2 | Text Muted: #a0a0a0
   - Header Accent: #ff6b35 (Burnt Mandarin)
   - Vocabulary / Section 1: #447F9F (Slate Blue)
   - Phrasal Verbs / Section 2: #3B8484 (Deep Sea Mineral)
   - Collocations / Section 3: #DE6E55 (Terracotta / Red Jasper)
   - Grammar / Section 4: #B06D29 (Petrified Ochre / Wood)
   - Idioms: #62193D (Plum Agate)
   - Focus Points: #DCE62C (Lichen / Sulfur)

### OUTPUT REQUIREMENT:
Return ONLY the complete, self-contained HTML document with embedded `<style>` and `<script>`. Do not wrap in markdown code blocks.
```

---

## 2. Compact Prompt (< 1,000 Characters)

Use this version when prompt length or context limits are constrained:

```markdown
Transform this Lesson Asset Card (LAC) into a self-contained, interactive HTML practice worksheet.

RULES:
1. NO listing items by category. Extrapolate active, level-adapted scenarios (dialogues, decision trees, contextual cloze) based on the LAC summary and title.
2. REGENERATION & FEEDBACK:
   - Multiple choice: <button class="option" data-correct="true|false" data-rationale="...">
   - Blanks: <input class="blank" data-answer="...">
   - Add <button class="regenerate-btn" data-prompt="..."> for on-demand AI question regeneration.
   - Embed JS for instant feedback: green #10b981 on correct, red #f43f5e on wrong + show rationale.
3. PALETTE A COLORS:
   - Dark theme: #131313 bg, #e0ded2 text, #1e1e1e card with #2e2e2e border.
   - Accents: Header #ff6b35, Sec1 #447F9F, Sec2 #3B8484, Sec3 #DE6E55, Sec4 #B06D29.

OUTPUT:
Return ONLY valid, standalone HTML with embedded <style> and <script>.
```

---

## 3. How Uploading Regenerating Resources Works in Admin
1. Go to **`/admin/resources`** or **`/admin/students/[id]`**.
2. Click **"New Resource"** or **"Upload Resource"**.
3. Paste the generated HTML into the content box.
4. The system automatically parses any `{{dynamic_fields}}` and hooks up all `<button class="regenerate-btn">` triggers.
5. When the student opens the worksheet, they can practice the current set or tap **"Regenerate"** to get fresh AI-generated variations infinitely.

