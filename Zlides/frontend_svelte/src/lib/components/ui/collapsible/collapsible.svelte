<script lang="ts">
	import { setContext } from "svelte";
	import { cn } from "$lib/utils";
	import type { Snippet } from "svelte";

	let { class: className = "", open = $bindable(false), onOpenChange, children }: {
		class?: string;
		open?: boolean;
		onOpenChange?: (o: boolean) => void;
		children?: Snippet;
	} = $props();

	let isOpen = $state(open);
	$effect(() => { isOpen = open; });

	setContext("collapsible", {
		get open() { return isOpen; },
		toggle() { isOpen = !isOpen; open = isOpen; onOpenChange?.(isOpen); }
	});
</script>

<div class={cn(className)} data-state={isOpen ? "open" : "closed"}>
	{@render children?.()}
</div>
