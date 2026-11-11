<script lang="ts">
  import { onMount } from 'svelte';
  import { cn } from '$lib/utils';

  export interface MorphOption {
    id: string;
    label: string;
    sublabel?: string;
    icon?: string;
    accentColor?: string;
    onclick?: () => void;
  }

  interface Props {
    label?: string;
    value?: string;
    options?: MorphOption[];
    placeholder?: string;
    align?: 'left' | 'right';
    class?: string;
    buttonClass?: string;
    width?: number;
    onselect?: (option: MorphOption) => void;
    children?: import('svelte').Snippet;
  }

  let {
    label = '',
    value = $bindable(''),
    options = [],
    placeholder = 'Select...',
    align = 'left',
    class: className = '',
    buttonClass = '',
    width = 250,
    onselect,
    children,
  }: Props = $props();

  let isOpen = $state(false);
  let isTransitioning = $state(false);
  let transitionTimer: ReturnType<typeof setTimeout> | null = null;
  let containerRef = $state<HTMLDivElement | null>(null);
  let chevronRef = $state<HTMLElement | null>(null);
  let peakXState = $state<number | null>(null);
  const uid = Math.random().toString(36).substring(2, 9);

  const selectedOption = $derived(options.find(o => o.id === value));
  const displayLabel = $derived(label || (selectedOption ? selectedOption.label : placeholder));

  // Precise sizing: each item has explicit 50px height
  const ROW_H = 50;
  const peakH = 8;
  const R = 8;
  const W = $derived(width);
  const H = $derived(options.length * ROW_H + peakH + 12);

  function calculatePeakX() {
    if (chevronRef && containerRef) {
      const cLeft = chevronRef.offsetLeft;
      const cWidth = chevronRef.offsetWidth;
      const contWidth = containerRef.offsetWidth;
      const chevCenter = cLeft + cWidth / 2;

      if (align === 'right') {
        const distFromRight = contWidth - chevCenter;
        peakXState = Math.max(R + 12, Math.min(W - R - 12, Math.round(W - distFromRight)));
      } else {
        peakXState = Math.max(R + 12, Math.min(W - R - 12, Math.round(chevCenter)));
      }
    } else {
      peakXState = null;
    }
  }

  $effect(() => {
    if (displayLabel || value || isOpen) {
      calculatePeakX();
    }
  });

  const fallbackPeakX = $derived(align === 'right' ? W - 22 : Math.min(W - 22, 110));
  const X_peak = $derived(peakXState ?? fallbackPeakX);

  // Exact Clockwise (Right) and Counter-Clockwise (Left) paths originating from the peak arrow
  const d1 = $derived(
    `M ${X_peak} 1.5 L ${X_peak + 7} ${peakH} H ${W - R - 1.5} A ${R} ${R} 0 0 1 ${W - 1.5} ${peakH + R} V ${H - R - 1.5} A ${R} ${R} 0 0 1 ${W - R - 1.5} ${H - 1.5} H ${W / 2}`
  );
  const d2 = $derived(
    `M ${X_peak} 1.5 L ${X_peak - 7} ${peakH} H ${R + 1.5} A ${R} ${R} 0 0 0 1.5 ${peakH + R} V ${H - R - 1.5} A ${R} ${R} 0 0 0 ${R + 1.5} ${H - 1.5} H ${W / 2}`
  );

  const halfLen = $derived(Math.round(W + H + 80));

  function openMenu() {
    if (transitionTimer) clearTimeout(transitionTimer);
    isTransitioning = true;
    isOpen = true;
    calculatePeakX();
  }

  function closeMenu() {
    isOpen = false;
    isTransitioning = true;
    if (transitionTimer) clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => {
      isTransitioning = false;
    }, 450);
  }

  function toggle(e?: MouseEvent | KeyboardEvent) {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (isOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  function handleSelect(opt: MorphOption, e?: MouseEvent) {
    if (e) e.stopPropagation();
    if (opt.onclick) {
      opt.onclick();
    } else {
      value = opt.id;
      onselect?.(opt);
    }
    closeMenu();
  }

  function handleOutsideClick(e: MouseEvent) {
    if (!isOpen) return;
    const path = e.composedPath ? e.composedPath() : [];
    const isInside = containerRef && (containerRef.contains(e.target as Node) || path.includes(containerRef));
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
    calculatePeakX();
    window.addEventListener('click', handleOutsideClick, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', calculatePeakX);
    return () => {
      if (transitionTimer) clearTimeout(transitionTimer);
      window.removeEventListener('click', handleOutsideClick, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', calculatePeakX);
    };
  });
</script>

<div class={cn('relative inline-block select-none', className)} bind:this={containerRef}>
  <!-- Trigger Control: Text Label + Naked Dropdown Chevron with Identical 2.5px Border -->
  <button
    type="button"
    class={cn(
      'group inline-flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all duration-200 cursor-pointer bg-ge-bg border-[2.5px] border-ge-border hover:border-ge-accent/70 shadow-sm active:scale-[0.98]',
      isOpen && 'border-ge-accent bg-[#1c1f24] shadow-[0_0_12px_rgba(240,178,62,0.25)]',
      buttonClass
    )}
    onclick={toggle}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } }}
    aria-expanded={isOpen}
    aria-haspopup="true"
  >
    {#if selectedOption?.accentColor}
      <span class="h-2.5 w-2.5 rounded-full shrink-0 shadow-sm" style="background-color: {selectedOption.accentColor}"></span>
    {/if}
    <span class="text-sm font-semibold text-white group-hover:text-ge-accent transition-colors truncate max-w-[145px]">
      {displayLabel}
    </span>

    <!-- Naked, clean, crisp dropdown chevron -->
    <span
      bind:this={chevronRef}
      class="inline-flex items-center justify-center shrink-0 ml-0.5"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class={cn('text-neutral-400 group-hover:text-ge-accent transition-all duration-300', isOpen && 'text-ge-accent rotate-180')}
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </span>
  </button>

  <!-- Popover Container with Notch Peak & Perimeter Stroke Animation -->
  {#if isOpen || isTransitioning}
    <div
      class={cn(
        'morph-menu absolute top-full -mt-0.5 z-50',
        align === 'right' ? 'right-0' : 'left-0',
        isOpen && 'expanded'
      )}
      style="width: {W}px; height: {H}px;"
    >
      <!-- Morphing SVG Outline: Traces from the Peak Notch on Both Sides Equally with 2.5px Thickness and Constant Amber Color -->
      <svg
        class="morph-svg absolute inset-0 w-full h-full overflow-visible pointer-events-none"
        viewBox="0 0 {W} {H}"
        fill="none"
      >
        <defs>
          <filter id="morph-shadow-{uid}" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000000" flood-opacity="0.95" />
          </filter>
        </defs>

        <!-- Path 1: Clockwise Stroke (Right Half) -->
        <path
          class="border1"
          d={d1}
          style="stroke-dasharray: {halfLen} {halfLen}; stroke-dashoffset: {isOpen ? 0 : -halfLen}px;"
          filter="url(#morph-shadow-{uid})"
        />

        <!-- Path 2: Counter-Clockwise Stroke (Left Half) -->
        <path
          class="border2"
          d={d2}
          style="stroke-dasharray: {isOpen ? `${halfLen} ${halfLen}` : `0 ${halfLen}`}; stroke-dashoffset: 0;"
        />
      </svg>

      <!-- Contents: Buttons with Clean Underline Dividers Emerge from the Outline -->
      <div
        class="morph-contents relative z-10 flex flex-col w-full h-full px-2"
        style="padding-top: {peakH + 4}px; padding-bottom: 6px;"
      >
        {#if children}
          {@render children()}
        {:else}
          {#each options as opt, index (opt.id)}
            <button
              type="button"
              onclick={(e) => handleSelect(opt, e)}
              class={cn(
                'morph-row flex items-center justify-between w-full h-[50px] px-3 text-left transition-colors cursor-pointer group',
                index < options.length - 1 ? 'border-b border-[#262b32]' : '',
                value === opt.id && !opt.onclick
                  ? 'text-ge-accent font-semibold bg-[#1c2024]/60'
                  : 'text-white hover:bg-[#20252b] active:bg-[#262c33] rounded-md'
              )}
            >
              <div class="flex items-center gap-2.5 min-w-0">
                {#if opt.accentColor}
                  <span class="h-2 w-2 rounded-full shrink-0 shadow-sm" style="background-color: {opt.accentColor}"></span>
                {/if}
                <div class="truncate">
                  <div class="text-sm font-semibold leading-snug group-hover:text-ge-accent transition-colors">
                    {opt.label}
                  </div>
                  {#if opt.sublabel}
                    <div class="text-xs text-neutral-400 leading-tight mt-0.5 font-normal">
                      {opt.sublabel}
                    </div>
                  {/if}
                </div>
              </div>

              {#if value === opt.id && !opt.onclick}
                <span class="text-xs text-ge-accent font-mono font-bold shrink-0">✓</span>
              {:else if opt.onclick}
                <span class="text-xs text-neutral-500 group-hover:text-ge-accent transition-colors shrink-0">➔</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  /* Base Container State: Clean opacity fade when transitioning */
  .morph-menu {
    opacity: 0;
    pointer-events: none;
    transition: opacity 450ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }

  .morph-menu.expanded {
    opacity: 1;
    pointer-events: auto;
  }

  /* 2.5px Robust Dual Perimeter Strokes Tracing from the Top Notch: Consistent #f0b23e Color & Thickness */
  .border1, .border2 {
    fill: #16181a;
    fill-opacity: 0;
    stroke: #f0b23e;
    stroke-opacity: 1;
    stroke-width: 2.5px;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition:
      stroke-dasharray 450ms cubic-bezier(0.4, 0.0, 0.2, 1),
      stroke-dashoffset 450ms cubic-bezier(0.4, 0.0, 0.2, 1),
      fill-opacity 400ms 40ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }

  /* When Expanded: Traces meet, background becomes solid #16181a */
  .expanded .border1,
  .expanded .border2 {
    fill-opacity: 0.98;
  }

  /* Contents emerge cleanly after the outline forms */
  .morph-contents {
    opacity: 0;
    transform: translateY(-4px);
    transition:
      opacity 250ms cubic-bezier(0.4, 0.0, 0.2, 1),
      transform 250ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }

  .expanded .morph-contents {
    opacity: 1;
    transform: translateY(0);
    transition:
      opacity 450ms 100ms cubic-bezier(0.4, 0.0, 0.2, 1),
      transform 450ms 100ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }
</style>
