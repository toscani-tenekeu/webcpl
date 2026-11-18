<script setup lang="ts">
defineProps<{ size?: number }>()
</script>

<template>
  <!-- Three stacked servers: shared hosting, VPS and the panel that runs them. -->
  <svg :width="size ?? 28" :height="size ?? 28" viewBox="0 0 32 32" aria-hidden="true" class="shrink-0">
    <rect width="32" height="32" rx="8" class="fill-primary" />
    <g class="fill-primary-foreground">
      <rect x="7" y="7.5" width="18" height="4.5" rx="1.5" opacity=".95" />
      <rect x="7" y="13.75" width="18" height="4.5" rx="1.5" opacity=".75" />
      <rect x="7" y="20" width="18" height="4.5" rx="1.5" opacity=".55" />
    </g>
    <g class="fill-primary">
      <circle cx="10.5" cy="9.75" r="1" />
      <circle cx="10.5" cy="16" r="1" />
      <circle cx="10.5" cy="22.25" r="1" />
    </g>
  </svg>
</template>
