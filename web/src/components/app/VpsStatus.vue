<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { t } from '@/lib/i18n'
import type { Vps } from '@/lib/types'

const props = defineProps<{ vps: Vps }>()
const STEPS: Record<string, string> = { queued: 'Waiting', image: 'Installing the system', setup: 'Setting up SSH' }
const view = computed(() => {
  const v = props.vps
  if (v.status === 'creating') return { label: STEPS[v.progress ?? ''] ?? 'Creating', tone: 'busy' }
  if (v.status === 'deleting') return { label: 'Deleting', tone: 'busy' }
  if (v.status === 'error') return { label: 'Failed', tone: 'bad' }
  if (v.state === 'running') return { label: 'Running', tone: 'good' }
  if (v.state === 'stopped') return { label: 'Stopped', tone: 'off' }
  return { label: v.state ? v.state.charAt(0).toUpperCase() + v.state.slice(1) : 'Unknown', tone: 'off' }
})
</script>

<template>
  <Badge :variant="view.tone === 'bad' ? 'destructive' : view.tone === 'good' ? 'default' : 'secondary'" class="gap-1.5">
    <Spinner v-if="view.tone === 'busy'" class="size-3" />
    <span v-else-if="view.tone === 'good'" class="size-1.5 rounded-full bg-emerald-400" />
    {{ t(view.label) }}
  </Badge>
</template>
