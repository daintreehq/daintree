<script lang="ts">
  let { rows = [] as string[] } = $props();
</script>

{#snippet row(label: string)}
  <li class="px-2 py-1">{label}</li>
{/snippet}

<ul class="divide-y">
  {#each rows as r}
    {@render row(r)}
  {/each}
</ul>
