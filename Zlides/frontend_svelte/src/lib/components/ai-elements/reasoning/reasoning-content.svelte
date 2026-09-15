<script lang="ts">
	import { cn } from "$lib/utils";
	import { CollapsibleContent } from "$lib/components/ui/collapsible/index.js";
	import Response from "$lib/components/ai-elements/response/response.svelte";

	interface Props {
		class?: string;
		content: string;
	}

	let { class: className = "", content, ...props }: Props = $props();
</script>

<CollapsibleContent
	class={cn(
		"mt-3 text-lg leading-relaxed text-white",
		"data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in outline-none",
		className
	)}
	{...props}
>
	<Response class="grid gap-2 text-lg leading-relaxed font-normal text-white" {content} />
</CollapsibleContent>
