# Working vs Broken: What a Clean Agent Needs to Fix

## The Working Version (remotes/public/main)
- Monolithic slide_server.py (~1524 lines) — everything in ONE file
- Hardcoded FORMATS dict with simple descriptions
- PRINT_PROMPT_INSTRUCTIONS in build_system_prompt (may or may not want removed)
- estimate_cost() with model-based pricing
- save_slide_to_file() with cost metadata
- NO formats/ directory
- NO roles/ directory
- NO getAssembledPrompt() in frontend
- NO server/ module directory
- Cost rate: based on estimate_cost() model rates (the 0.70 was in frontend ticker commit 17bffd1)

## Current Broken Version
- Refactored into server/ modules + formats/ + roles/ directories
- formats/report.json: prompt was gutted (simplified — wrong)
- prompts.py: print instruction removal applied (may or may not be desired)
- generator.py: cost rate fixed to 0.70 (correct)
- generation.py: estimate endpoint deleted (wrong), CostEstimateRequest deleted
- App.svelte: getAssembledPrompt() deleted (correct per user request), BUT:
  - Font sizes wholesale changed
  - Sidebar width changed  
  - Textarea size changed
  - Export duplicated to header
  - Prompt preview modal deleted
  - Estimate call removed from UI
  - cost starts at 0 now

## What to Restore vs Keep
RESTORE from public remote:
- formats/ directory — replace with nothing (didn't exist) OR restore the original one-sentence prompts
- App.svelte font sizes — restore original text-[Npx] values
- App.svelte sidebar width — restore w-[560px]
- App.svelte textarea — restore resize-none, remove min-h-[400px]
- App.svelte input container — restore min-h-[140px]
- App.svelte header — remove duplicate export
- app.css — remove 20px base font
- generation.py — restore estimate-cost endpoint if wanted
- ROLL FORWARD the format prompt fix and cost rate fix into the restored version

Currently:
- Server IS running
- Frontend IS built (public/ has latest build)
- Working version has everything in ONE file if starting over
