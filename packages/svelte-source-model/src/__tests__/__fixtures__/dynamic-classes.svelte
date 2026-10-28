<script lang="ts">
  let { active = false, size = "sm", ...rest } = $props();
  const sizes = { sm: "p-2 text-sm", lg: "p-4 text-lg" };
</script>

<button class={["btn", active && "bg-accent"]} class:on={active}>Array form</button>
<button class={active ? "bg-a" : "bg-b"}>Ternary form</button>
<div class="grid {active ? 'gap-2' : 'gap-8'}">Mixed literal and expression</div>
<div class={sizes[size]}>Lookup form</div>
<div {...rest} class="text-sm">Spread before class</div>
<div class="text-sm" {...rest}>Class before spread</div>
