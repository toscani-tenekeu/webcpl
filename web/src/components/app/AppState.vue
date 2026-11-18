<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { t } from '@/lib/i18n'

const props = defineProps<{ state: string }>()
const view = computed(() => {
  if (props.state === 'active') return { label: 'Running', tone: 'good' }
  if (props.state === 'activating' || props.state === 'reloading') return { label: 'Starting', tone: 'busy' }
  if (props.state === 'deactivating') return { label: 'Stopping', tone: 'busy' }
  if (props.state === 'failed') return { label: 'Crashed', tone: 'bad' }
  return { label: 'Stopped', tone: 'off' }
})
</script>

<template>
  <Badge :variant="view.tone === 'bad' ? 'destructive' : view.tone === 'good' ? 'default' : 'secondary'" class="gap-1.5">
    <Spinner v-if="view.tone === 'busy'" class="size-3" />
    <span v-else-if="view.tone === 'good'" class="size-1.5 rounded-full bg-emerald-400" />
    {{ t(view.label) }}
  </Badge>
</template>
