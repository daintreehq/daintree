<script lang="ts">
  let { markup = "<b>raw</b>" } = $props();
</script>

<div class="prose">{@html markup}</div>
<canvas class="block size-32"></canvas>
<iframe class="w-full" title="external" src="https://example.com"></iframe>
