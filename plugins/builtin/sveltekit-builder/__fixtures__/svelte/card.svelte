<script lang="ts">
  let { plan = "", ctaVariant = "solid", featured = false, tier = 1 } = $props();
</script>

<article class="rounded border p-4">
  <h2 class="font-bold">{plan}</h2>
  <button class="mt-2 px-3 py-1">Choose {plan}</button>
</article>

<style>
  article { container-type: inline-size; }
</style>
