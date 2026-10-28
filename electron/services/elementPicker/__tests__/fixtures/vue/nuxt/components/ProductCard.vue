<script setup>
defineProps({ title: String });
</script>

<template>
  <section class="product">
    <h3 class="product-title">{{ title }}</h3>
    <slot />
  </section>
</template>
