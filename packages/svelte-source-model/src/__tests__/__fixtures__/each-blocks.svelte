<script lang="ts">
  let { items = [] as Array<{ id: string; label: string }> } = $props();
</script>

<ul class="list-none">
  {#each items as item (item.id)}
    <li class="border p-1">{item.label}</li>
  {/each}
</ul>

<ul>
  {#each items as item}
    <li class="border p-2">Unkeyed {item.label}</li>
  {/each}
</ul>
