<script setup>
import Badge from "./Badge.vue";
import Card from "./Card.vue";
import Legal from "./Legal.vue";
import Modal from "./Modal.vue";
import Note from "./Note.vue";
import Nothing from "./Nothing.vue";
import Pair from "./Pair.vue";
import Words from "./Words.vue";
import Wrapper from "./Wrapper.vue";
</script>

<template>
  <main class="app">
    <Card title="Fixture">
      <button class="cta">Go</button>
      <Badge :count="3" />
    </Card>
    <Wrapper class="wrapped" />
    <Note class="noted" />
    <Pair />
    <Modal />
    <Nothing />
    <Words />
    <Legal />
  </main>
</template>
