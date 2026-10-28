<script setup>
const part = "modal";
</script>

<template>
  <div class="modal-wrap">
    <span class="opener">open</span>
    <Teleport to="#overlay">
      <aside class="dialog"><p class="dialog-text">hello</p></aside>
    </Teleport>
  </div>
</template>
