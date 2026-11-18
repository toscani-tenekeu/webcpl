<script setup lang="ts">
defineProps<{ size?: number }>()
</script>

<template>
  <!-- Three stacked layers: websites, VPS and the server under them. -->
  <svg :width="size ?? 28" :height="size ?? 28" viewBox="0 0 32 32" aria-hidden="true" class="shrink-0">
    <rect width="32" height="32" rx="8" class="fill-primary" />
    <path d="M16 6.5l9 4.6-9 4.6-9-4.6z" class="fill-primary-foreground" />
    <path d="M7 15.6l9 4.6 9-4.6" fill="none" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" opacity=".75" class="stroke-primary-foreground" />
    <path d="M7 20.4l9 4.6 9-4.6" fill="none" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" opacity=".5" class="stroke-primary-foreground" />
  </svg>
</template>
