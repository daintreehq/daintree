<script lang="ts">
  let { ready = false, promise = Promise.resolve("x") } = $props();
</script>

{#if ready}
  <p class="text-green">Ready branch</p>
{:else}
  <p class="text-grey">Pending branch</p>
{/if}

{#await promise}
  <p class="opacity-50">Loading</p>
{:then value}
  <p class="font-medium">{value}</p>
{:catch error}
  <p class="text-red">{error}</p>
{/await}
