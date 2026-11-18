<script setup lang="ts">
import { LIMITS } from '@shared/limits'
import { computed } from 'vue'
import { Progress } from '@/components/ui/progress'
import { t } from '@/lib/i18n'
import type { ResellerUsage } from '@/lib/types'

const props = defineProps<{ usage: ResellerUsage }>()

const rows = computed(() =>
  LIMITS.reseller
    .filter((f) => f.type === 'number')
    .map((f) => {
      const cap = props.usage.caps[f.key]
      const used = props.usage.used[f.key]
      const open = cap === null || cap === undefined
      return {
        key: f.key,
        label: t(f.label),
        used: used === null || used === Infinity ? '∞' : String(used ?? 0),
        cap: open ? '∞' : String(cap),
        percent: open ? 0 : used === Infinity || used === null ? 100 : Math.min(100, ((used ?? 0) / Math.max(1, Number(cap))) * 100),
      }
    }),
)
</script>

<template>
  <div class="grid gap-x-8 gap-y-3 sm:grid-cols-2">
    <div v-for="row in rows" :key="row.key" class="flex flex-col gap-1">
      <div class="flex items-baseline justify-between gap-2 text-sm">
        <span class="text-muted-foreground">{{ row.label }}</span>
        <span class="font-mono">{{ row.used }} <span class="text-muted-foreground">/ {{ row.cap }}</span></span>
      </div>
      <Progress :model-value="row.percent" class="h-1.5" />
    </div>
  </div>
</template>
