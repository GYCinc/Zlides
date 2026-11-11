<script lang="ts">
  import { cn } from '$lib/utils';

  interface Props {
    class?: string;
  }

  let {
    class: className,
  }: Props = $props();
</script>

<div class={cn('flex items-center justify-center w-full py-1 pb-2 border-b border-ge-border-soft select-none flex-shrink-0', className)}>
  <div class="relative flex items-center justify-center w-full group cursor-pointer" title="Zlides">
    <picture class="flex items-center justify-center w-full px-2">
      <source srcset="/brand/logo_hero.webp" type="image/webp" />
      <img
        src="/brand/logo_hero.png"
        alt="Zlides"
        class="h-14 sm:h-16 md:h-18 w-auto max-w-full object-contain brightness-110 contrast-110 transition-all duration-300 group-hover:brightness-125 group-hover:scale-[1.02]"
        loading="eager"
      />
    </picture>
  </div>
</div>
