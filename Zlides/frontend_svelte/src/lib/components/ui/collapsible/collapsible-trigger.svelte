<script lang="ts">
	import { getContext } from "svelte";
	import type { Snippet } from "svelte";

	let { children }: { children?: Snippet } = $props();
	const ctx = getContext<{ open: boolean; toggle: () => void }>("collapsible");
</script>

<button
	type="button"
	data-state={ctx.open ? "open" : "closed"}
	onclick={() => ctx.toggle()}
>
	{@render children?.()}
</button>
