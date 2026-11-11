<script lang="ts">
  import { onMount } from 'svelte';
  import { cn } from '$lib/utils';

  interface Props {
    typeSpace: string;
    formatSpace: string;
    styleSpace: string;
    previewMode: 'document' | 'slides' | 'webpage';
    contractsSigned: boolean;
    class?: string;
    ontypechange?: (mode: 'document' | 'slides' | 'webpage') => void;
  }

  let {
    typeSpace = $bindable(''),
    formatSpace = $bindable(''),
    styleSpace = $bindable(''),
    previewMode = $bindable('document'),
    contractsSigned,
    class: className = '',
    ontypechange,
  }: Props = $props();

  let isOpen = $state(false);
  let isTransitioning = $state(false);
  let transitionTimer: ReturnType<typeof setTimeout> | null = null;
  let activeTab = $state<'type' | 'format' | 'style'>('type');
  let popoverRef = $state<HTMLDivElement | null>(null);

  const DEFAULT_TYPE_PROMPT = 'Generate an A4 print-ready educational document in standalone HTML with embedded CSS.';
  const SLIDES_TYPE_PROMPT = 'Generate a 16:9 presentation slide deck formatted in clean standalone HTML with embedded CSS.';
  const WEBPAGE_TYPE_PROMPT = 'Generate a fluid continuous single-scroll report formatted in clean standalone HTML with embedded CSS.';
  const DEFAULT_FORMAT_PROMPT = 'Strict modular layout: 8 distinct exercise modules with Cloze blanks, multiple choice options, and self-study boxes.';
  const CONTINUOUS_REPORT_PROMPT = 'Single-scroll report layout: fluid height, Bento grid cards, KPI statistics, and vocabulary comparison matrices.';
  const DEFAULT_STYLE_TOKENS = 'Palette A: Deep Charcoal (#131313, #16181a), Pale Gold / Honey Amber (#f0b23e), Seafoam Teal (#4fb3a9), High-contrast Pure White text on dark cards.';

  function closeMenu() {
    isOpen = false;
    isTransitioning = true;
    if (transitionTimer) clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => {
      isTransitioning = false;
    }, 400);
  }

  function toggle(e?: MouseEvent) {
    if (e) e.stopPropagation();
    if (isOpen) {
      closeMenu();
    } else {
      if (transitionTimer) clearTimeout(transitionTimer);
      isTransitioning = true;
      isOpen = true;
    }
  }

  function handleOutsideClick(e: MouseEvent) {
    if (!isOpen) return;
    const path = e.composedPath ? e.composedPath() : [];
    const isInside = popoverRef && (popoverRef.contains(e.target as Node) || path.includes(popoverRef));
    if (!isInside) {
      closeMenu();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && isOpen) {
      e.stopPropagation();
      closeMenu();
    }
  }

  onMount(() => {
    window.addEventListener('click', handleOutsideClick, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      if (transitionTimer) clearTimeout(transitionTimer);
      window.removeEventListener('click', handleOutsideClick, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  });

  const width = 420;
  const height = 360;
  const radius = 12;
  const padding = 2;
  const rectW = width - padding * 2;
  const rectH = height - padding * 2;
  const perimeter = 2 * (rectW + rectH) - 8 * radius + 2 * Math.PI * radius;
  const halfPerimeter = Math.round(perimeter / 2);
</script>

<div class={cn('relative inline-block select-none', className)} bind:this={popoverRef}>
  <!-- Trigger Button -->
  <button
    type="button"
    onclick={toggle}
    class={cn(
      'h-8 px-3 rounded-lg border border-ge-border bg-ge-bg text-white text-sm font-medium hover:border-ge-accent/60 hover:text-ge-accent transition-all flex items-center gap-2 cursor-pointer shadow-sm active:scale-95',
      isOpen && 'border-ge-accent bg-[#1c1f24] text-ge-accent ring-1 ring-ge-accent/30'
    )}
    title="Configure Generation Contracts (Type, Format, Style)"
    aria-expanded={isOpen}
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-ge-accent shrink-0">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
    <span>Contracts</span>
    <span class={cn('text-xs font-mono px-1.5 py-0.2 rounded font-semibold', contractsSigned ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-500/40' : 'bg-rose-950/80 text-rose-400 border border-rose-500/40')}>
      {contractsSigned ? 'signed' : 'unsigned'}
    </span>
  </button>

  <!-- Morphing Contracts Popover -->
  {#if isOpen || isTransitioning}
    <div
      class={cn(
        'contracts-morph-popover absolute right-0 top-full mt-2 z-50 pointer-events-none',
        isOpen && 'expanded pointer-events-auto'
      )}
      style="width: {width}px; height: {height}px;"
    >
      <!-- SVG Animated Morphing Borders -->
      <svg
        class="absolute inset-0 w-full h-full overflow-visible pointer-events-none"
        viewBox="0 0 {width} {height}"
        fill="none"
      >
        <defs>
          <filter id="contract-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#000000" flood-opacity="0.85" />
          </filter>
        </defs>

        <path
          class="border1"
          d="M {padding + radius} {padding} h {rectW - 2 * radius} a {radius} {radius} 0 0 1 {radius} {radius} v {rectH - 2 * radius} a {radius} {radius} 0 0 1 -{radius} {radius} h -{rectW - 2 * radius} a {radius} {radius} 0 0 1 -{radius} -{radius} v -{rectH - 2 * radius} a {radius} {radius} 0 0 1 {radius} -{radius} z"
          style="stroke-dasharray: {halfPerimeter} {halfPerimeter}; stroke-dashoffset: {isOpen ? 0 : -halfPerimeter}px;"
          filter="url(#contract-shadow)"
        />

        <path
          class="border2"
          d="M {padding + radius} {padding} h {rectW - 2 * radius} a {radius} {radius} 0 0 1 {radius} {radius} v {rectH - 2 * radius} a {radius} {radius} 0 0 1 -{radius} {radius} h -{rectW - 2 * radius} a {radius} {radius} 0 0 1 -{radius} -{radius} v -{rectH - 2 * radius} a {radius} {radius} 0 0 1 {radius} -{radius} z"
          style="stroke-dasharray: {isOpen ? `${halfPerimeter} ${halfPerimeter}` : `0 ${halfPerimeter}`}; stroke-dashoffset: 0;"
        />
      </svg>

      <!-- Popover Contents -->
      <div class="popover-contents relative z-10 p-4 flex flex-col h-full text-left">
        <!-- Header with Tabs -->
        <div class="flex items-center justify-between border-b border-[#2e343b] pb-2.5 mb-3">
          <div class="flex items-center gap-1">
            <button
              type="button"
              onclick={() => activeTab = 'type'}
              class={cn(
                'text-xs font-semibold px-2.5 py-1 rounded-md transition-colors cursor-pointer',
                activeTab === 'type' ? 'bg-ge-accent text-black font-bold' : 'text-neutral-300 hover:text-white hover:bg-[#242930]'
              )}
            >
              1 · Type
            </button>
            <button
              type="button"
              onclick={() => activeTab = 'format'}
              class={cn(
                'text-xs font-semibold px-2.5 py-1 rounded-md transition-colors cursor-pointer',
                activeTab === 'format' ? 'bg-ge-accent text-black font-bold' : 'text-neutral-300 hover:text-white hover:bg-[#242930]'
              )}
            >
              2 · Format
            </button>
            <button
              type="button"
              onclick={() => activeTab = 'style'}
              class={cn(
                'text-xs font-semibold px-2.5 py-1 rounded-md transition-colors cursor-pointer',
                activeTab === 'style' ? 'bg-ge-accent text-black font-bold' : 'text-neutral-300 hover:text-white hover:bg-[#242930]'
              )}
            >
              3 · Style
            </button>
          </div>

          <button
            type="button"
            onclick={closeMenu}
            class="text-neutral-400 hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-[#242930]"
          >
            ✕
          </button>
        </div>

        <!-- Tab Content Area -->
        <div class="flex-1 flex flex-col justify-between overflow-hidden">
          {#if activeTab === 'type'}
            <div class="flex flex-col gap-2 flex-1">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-ge-accent uppercase tracking-wider">Archetype Contract</span>
                <div class="flex items-center gap-1.5">
                  <button
                    type="button"
                    class="text-xs px-2 py-0.5 rounded bg-[#1e2227] border border-[#343b44] text-neutral-200 hover:border-ge-accent hover:text-white"
                    onclick={() => { typeSpace = DEFAULT_TYPE_PROMPT; previewMode = 'document'; ontypechange?.('document'); }}
                  >
                    A4 Doc
                  </button>
                  <button
                    type="button"
                    class="text-xs px-2 py-0.5 rounded bg-[#1e2227] border border-[#343b44] text-neutral-200 hover:border-ge-accent hover:text-white"
                    onclick={() => { typeSpace = SLIDES_TYPE_PROMPT; previewMode = 'slides'; ontypechange?.('slides'); }}
                  >
                    16:9 Slides
                  </button>
                  <button
                    type="button"
                    class="text-xs px-2 py-0.5 rounded bg-[#1e2227] border border-[#343b44] text-neutral-200 hover:border-ge-accent hover:text-white"
                    onclick={() => { typeSpace = WEBPAGE_TYPE_PROMPT; previewMode = 'webpage'; ontypechange?.('webpage'); }}
                  >
                    Webpage
                  </button>
                </div>
              </div>
              <textarea
                bind:value={typeSpace}
                rows="6"
                class="w-full flex-1 bg-[#101214] border border-[#2e343b] rounded-lg p-2.5 text-xs text-white placeholder:text-neutral-500 focus:border-ge-accent outline-none font-mono leading-relaxed resize-none"
                placeholder="Archetype contract instructions..."
              ></textarea>
            </div>
          {:else if activeTab === 'format'}
            <div class="flex flex-col gap-2 flex-1">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-[#4fb3a9] uppercase tracking-wider">Format Blueprint</span>
                <div class="flex items-center gap-1.5">
                  <button
                    type="button"
                    class="text-xs px-2 py-0.5 rounded bg-[#1e2227] border border-[#343b44] text-neutral-200 hover:border-[#4fb3a9] hover:text-white"
                    onclick={() => formatSpace = DEFAULT_FORMAT_PROMPT}
                  >
                    Worksheet
                  </button>
                  <button
                    type="button"
                    class="text-xs px-2 py-0.5 rounded bg-[#1e2227] border border-[#343b44] text-neutral-200 hover:border-[#4fb3a9] hover:text-white"
                    onclick={() => formatSpace = CONTINUOUS_REPORT_PROMPT}
                  >
                    Report
                  </button>
                </div>
              </div>
              <textarea
                bind:value={formatSpace}
                rows="6"
                class="w-full flex-1 bg-[#101214] border border-[#2e343b] rounded-lg p-2.5 text-xs text-white placeholder:text-neutral-500 focus:border-ge-accent outline-none font-mono leading-relaxed resize-none"
                placeholder="Format blueprint contract instructions..."
              ></textarea>
            </div>
          {:else if activeTab === 'style'}
            <div class="flex flex-col gap-2 flex-1">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-[#f0b23e] uppercase tracking-wider">Style Tokens (Palette A)</span>
                <button
                  type="button"
                  class="text-xs px-2 py-0.5 rounded bg-[#1e2227] border border-[#343b44] text-neutral-200 hover:border-[#f0b23e] hover:text-white"
                  onclick={() => styleSpace = DEFAULT_STYLE_TOKENS}
                >
                  Reset Palette A
                </button>
              </div>
              <textarea
                bind:value={styleSpace}
                rows="6"
                class="w-full flex-1 bg-[#101214] border border-[#2e343b] rounded-lg p-2.5 text-xs text-white placeholder:text-neutral-500 focus:border-ge-accent outline-none font-mono leading-relaxed resize-none"
                placeholder="Style contract tokens..."
              ></textarea>
            </div>
          {/if}

          <div class="flex items-center justify-between pt-2.5 border-t border-[#2e343b] mt-2">
            <span class="text-xs text-neutral-400 font-mono">
              {contractsSigned ? '✓ All 3 contract spaces signed' : '⚠️ Unsigned contract spaces'}
            </span>
            <button
              type="button"
              onclick={closeMenu}
              class="px-3 py-1 bg-ge-accent rounded-md text-black font-bold text-xs hover:brightness-110"
            >
              Apply & Close
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .contracts-morph-popover {
    opacity: 0;
    transition: opacity 350ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }

  .contracts-morph-popover.expanded {
    opacity: 1;
  }

  .border1, .border2 {
    fill: #14171a;
    fill-opacity: 0;
    stroke: transparent;
    stroke-width: 1.5px;
    transition:
      stroke 350ms cubic-bezier(0.4, 0.0, 0.2, 1),
      stroke-dasharray 350ms cubic-bezier(0.4, 0.0, 0.2, 1),
      stroke-dashoffset 350ms cubic-bezier(0.4, 0.0, 0.2, 1),
      fill-opacity 350ms 30ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }

  .popover-contents {
    opacity: 0;
    transform: translateY(-4px);
    transition: opacity 250ms cubic-bezier(0.4, 0.0, 0.2, 1), transform 250ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }

  .expanded .border1,
  .expanded .border2 {
    fill-opacity: 0.98;
    stroke: #f0b23e;
  }

  .expanded .popover-contents {
    opacity: 1;
    transform: translateY(0);
    transition: opacity 350ms 80ms cubic-bezier(0.4, 0.0, 0.2, 1), transform 350ms 80ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }
</style>
