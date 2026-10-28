<script>
export default {
  name: "FancyCard",
  props: { title: String },
};
</script>

<template>
  <section class="card">
    <h2 class="card-title">{{ title }}</h2>
    <slot />
  </section>
</template>
