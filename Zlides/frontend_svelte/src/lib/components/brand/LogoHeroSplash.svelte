<script lang="ts">
  import { cn } from '$lib/utils';

  interface Props {
    class?: string;
  }

  let {
    class: className,
  }: Props = $props();
</script>

<div class={cn('w-full h-full flex flex-col items-center justify-center p-6 sm:p-8 bg-[#0a0b0c] text-white relative select-none', className)}>
  <div class="relative z-10 flex flex-col items-center max-w-2xl w-full text-center my-auto">
    <!-- Borderless Logo Hero: Directly on the Pure Dark Background -->
    <div class="relative group mb-5 flex items-center justify-center w-full px-4">
      <picture class="relative z-10 flex items-center justify-center w-full max-w-xl">
        <source srcset="/brand/logo_splash.webp" type="image/webp" />
        <img
          src="/brand/logo_splash.png"
          alt="Zlides"
          class="h-24 sm:h-28 md:h-36 max-h-40 w-auto max-w-full object-contain brightness-110 contrast-110 filter drop-shadow-[0_12px_32px_rgba(0,0,0,0.95)] transition-all duration-300 group-hover:scale-[1.02] group-hover:brightness-120"
          loading="eager"
        />
      </picture>
    </div>

    <!-- Title Only -->
    <h1 class="text-2xl sm:text-3xl font-bold font-raleway text-white tracking-tight leading-snug">
      Precision Educational Architecture
    </h1>
  </div>
</div>
