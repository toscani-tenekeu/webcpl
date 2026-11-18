<script setup lang="ts">
import { LIMITS, type Limits, type PlanKind } from '@shared/limits'
import { computed } from 'vue'
import { t } from '@/lib/i18n'

const props = defineProps<{ kind: PlanKind; limits: Limits; max?: number }>()

/** The most telling limits first, written short: "5 GB disk", "∞ domains". */
const items = computed(() =>
  LIMITS[props.kind]
    .filter((field) => field.type === 'number')
    .slice(0, props.max ?? 99)
    .map((field) => {
      const value = props.limits[field.key]
      const amount = value === null || value === undefined ? '∞' : field.unit === 'MB' && Number(value) >= 1024 ? `${+(Number(value) / 1024).toFixed(1)} GB` : `${value}${field.unit && field.unit !== 'MB' && !field.unit.startsWith('%') ? ` ${field.unit}` : field.unit === 'MB' ? ' MB' : ''}`
      return { key: field.key, amount, label: t(field.label) }
    }),
)
</script>

<template>
  <div class="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
    <span v-for="item in items" :key="item.key"><span class="text-foreground font-mono">{{ item.amount }}</span> {{ item.label.toLowerCase() }}</span>
  </div>
</template>
