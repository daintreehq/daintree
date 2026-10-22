<script lang="ts">
  let { heading = "Welcome" } = $props();
</script>

<section class="flex flex-col gap-4 p-6">
  <h1 class="text-2xl font-bold">Plain literal heading</h1>
  <p class="text-sm">Literal paragraph text.</p>
  <a class="underline" href="/pricing">Pricing</a>
  <img class="rounded" src="/logo.png" alt="Acme" />
  <svg class="size-4" viewBox="0 0 16 16"><circle class="fill-current" cx="8" cy="8" r="4" /></svg>
  <h2>{heading}</h2>
</section>
