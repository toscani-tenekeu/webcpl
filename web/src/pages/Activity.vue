<script setup lang="ts">
import { HistoryIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useResource } from '@/composables/useResource'
import { api } from '@/lib/api'
import { shortDate } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { ActivityEvent } from '@/lib/types'

const { data, error } = useResource<{ events: ActivityEvent[] }>('/api/activity')
const older = ref<ActivityEvent[]>([])
const end = ref(false)
const busy = ref(false)
const events = computed(() => [...(data.value?.events ?? []), ...older.value])

async function loadOlder() {
  busy.value = true
  const last = events.value.at(-1)
  const r = await api<{ events: ActivityEvent[] }>(`/api/activity?before=${last?.id ?? 0}`).catch(() => ({ events: [] }))
  older.value.push(...r.events)
  end.value = r.events.length < 100
  busy.value = false
}
</script>

<template>
  <div>
    <h2 class="text-2xl font-semibold tracking-tight">{{ t('Activity') }}</h2>
    <p class="text-muted-foreground mt-1 text-sm">{{ t('Sign-ins and changes made in the panel.') }}</p>
  </div>
  <LoadError :message="error" />
  <Card v-if="data" class="py-0">
    <CardContent class="px-0">
      <p v-if="!events.length" class="text-muted-foreground p-6 text-sm">{{ t('Nothing yet.') }}</p>
      <ul v-else class="divide-y">
        <li v-for="e in events" :key="e.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-2.5 text-sm">
          <span class="font-mono font-medium">{{ e.actor ?? t('system') }}</span>
          <span>{{ t(e.action) }}</span>
          <span v-if="e.subject && e.subject !== e.actor" class="font-mono">{{ e.subject }}</span>
          <span v-if="e.detail && e.detail !== e.subject" class="text-muted-foreground truncate">· {{ e.detail }}</span>
          <span class="text-muted-foreground ml-auto text-xs whitespace-nowrap">{{ shortDate(e.at) }}<template v-if="e.ip"> · {{ e.ip }}</template></span>
        </li>
      </ul>
    </CardContent>
  </Card>
  <Skeleton v-else-if="!error" class="h-96 rounded-xl" />
  <div v-if="events.length >= 100 && !end" class="flex justify-center">
    <Button variant="outline" :disabled="busy" @click="loadOlder">
      <Spinner v-if="busy" data-icon="inline-start" /><HistoryIcon v-else data-icon="inline-start" /> {{ t('Load older') }}
    </Button>
  </div>
</template>
