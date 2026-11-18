<script setup lang="ts">
import { ActivityIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useResource } from '@/composables/useResource'
import { bytes } from '@/lib/format'
import { t } from '@/lib/i18n'

interface Sample { at: number; load: number; mem_used: number; mem_total: number; disk_used: number; disk_total: number; rx: number; tx: number }
const { data } = useResource<{ samples: Sample[] }>('/api/server/metrics', 60_000)
const W = 300
const H = 64

/** An SVG path for values between 0 and max over the last day. */
function path(values: number[], max: number) {
  if (values.length < 2) return ''
  const step = W / (values.length - 1)
  return values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(H - Math.min(1, v / (max || 1)) * (H - 4) - 2).toFixed(1)}`).join(' ')
}

const charts = computed(() => {
  const s = data.value?.samples ?? []
  const last = s.at(-1)
  const netMax = Math.max(1, ...s.map((x) => Math.max(x.rx, x.tx)))
  return [
    { label: 'Processor load', now: last ? `${Math.round(last.load * 100)}%` : '—', lines: [{ d: path(s.map((x) => x.load), 1), cls: 'stroke-sky-500' }] },
    { label: 'Memory', now: last ? `${bytes(last.mem_used)} / ${bytes(last.mem_total)}` : '—', lines: [{ d: path(s.map((x) => x.mem_used / x.mem_total), 1), cls: 'stroke-violet-500' }] },
    { label: 'Disk', now: last ? `${bytes(last.disk_used)} / ${bytes(last.disk_total)}` : '—', lines: [{ d: path(s.map((x) => x.disk_used / x.disk_total), 1), cls: 'stroke-amber-500' }] },
    {
      label: 'Network',
      now: last ? `↓ ${bytes(last.rx)}/s · ↑ ${bytes(last.tx)}/s` : '—',
      lines: [{ d: path(s.map((x) => x.rx), netMax), cls: 'stroke-emerald-500' }, { d: path(s.map((x) => x.tx), netMax), cls: 'stroke-rose-500' }],
    },
  ]
})
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2"><ActivityIcon class="size-4" /> {{ t('Last 24 hours') }}</CardTitle>
      <CardDescription>{{ t('Measured every minute.') }}</CardDescription>
    </CardHeader>
    <CardContent class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
      <div v-for="c in charts" :key="c.label" class="flex flex-col gap-1.5">
        <div class="flex items-baseline justify-between gap-2 text-sm">
          <span class="text-muted-foreground">{{ t(c.label) }}</span>
          <span class="truncate font-mono text-xs">{{ c.now }}</span>
        </div>
        <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="bg-muted/40 h-16 w-full rounded-md">
          <path v-for="(l, i) in c.lines" :key="i" :d="l.d" fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke" :class="l.cls" />
        </svg>
      </div>
    </CardContent>
  </Card>
</template>
