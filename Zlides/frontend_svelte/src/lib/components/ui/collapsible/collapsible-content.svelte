<script lang="ts">
	import { slide } from "svelte/transition";
	import { getContext } from "svelte";
	import type { Snippet } from "svelte";

	let { class: className = "", children }: { class?: string; children?: Snippet } = $props();
	const ctx = getContext<{ open: boolean; toggle: () => void }>("collapsible");
</script>

{#if ctx.open}
	<div class={className} transition:slide={{ duration: 150 }}>
		{@render children?.()}
	</div>
{/if}
