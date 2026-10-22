<script lang="ts">
  import Card from "./card.svelte";
  let { plans = [] as string[] } = $props();
</script>

<Card plan="Basic" ctaVariant="solid" />
<Card plan="Pro" ctaVariant="solid" featured />
<Card plan="Enterprise" ctaVariant="outline" tier={3} />

{#each plans as plan}
  <Card {plan} ctaVariant="solid" />
{/each}
