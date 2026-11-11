<script lang="ts">
	import { getContext } from "svelte";
	import type { Snippet } from "svelte";

	let { children, class: className = "", ...rest }: { children?: Snippet; class?: string } = $props();
	const ctx = getContext<{ open: boolean; toggle: () => void }>("collapsible");
</script>

<button
	type="button"
	data-state={ctx.open ? "open" : "closed"}
	onclick={() => ctx.toggle()}
	{...rest}
	class={className}
>
	{@render children?.()}
</button>
