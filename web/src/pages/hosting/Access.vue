<script setup lang="ts">
import { HardDriveIcon, KeyRoundIcon, SaveIcon, TerminalIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import CopyLine from '@/components/app/CopyLine.vue'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useResource } from '@/composables/useResource'
import { messageOf, put } from '@/lib/api'
import { bytes, date } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { HostingInfo } from '@/lib/types'

const { data, error, reload } = useResource<HostingInfo>('/api/hosting')
const php = ref<Record<string, string | boolean>>({})
watch(data, (d) => { if (d) php.value = { memory_limit: '', upload_max_filesize: '', post_max_size: '', max_execution_time: '', max_input_vars: '', display_errors: false, ...d.phpSettings } }, { immediate: true })
const saving = ref(false)

async function savePhp() {
  saving.value = true
  try {
    await put('/api/php', php.value)
    toast.success(t('PHP settings applied'))
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  saving.value = false
}

const ftpLine = computed(() => (data.value ? `ftp://${data.value.sftp.username}@${data.value.sftp.host}` : ''))
const diskLimit = computed(() => (typeof data.value?.limits.disk_mb === 'number' ? data.value.limits.disk_mb * 1024 * 1024 : null))
const bandwidthLimit = computed(() => (typeof data.value?.limits.bandwidth_gb === 'number' ? data.value.limits.bandwidth_gb * 1e9 : null))
const FIELDS = [
  ['memory_limit', 'Memory per script', '256M'],
  ['upload_max_filesize', 'Largest upload', '64M'],
  ['post_max_size', 'Largest form post', '64M'],
  ['max_execution_time', 'Time limit (seconds)', '60'],
  ['max_input_vars', 'Form fields', '3000'],
] as const
</script>

<template>
  <div>
    <h2 class="text-2xl font-semibold tracking-tight">{{ t('Access and PHP') }}</h2>
    <p class="text-muted-foreground mt-1 text-sm">{{ t('How to reach your files, and how PHP runs for your sites.') }}</p>
  </div>
  <LoadError :message="data ? '' : error" />

  <template v-if="data">
    <div class="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2"><TerminalIcon class="size-4" /> {{ data.sftp.ssh ? 'SFTP / SSH' : 'SFTP' }}</CardTitle>
          <CardDescription>{{ t('Sign in with your panel password. Use port 22.') }}</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-3">
          <CopyLine :text="`sftp ${data.sftp.username}@${data.sftp.host}`" />
          <CopyLine v-if="data.sftp.ssh" :text="`ssh ${data.sftp.username}@${data.sftp.host}`" />
          <p v-else class="text-muted-foreground text-xs">{{ t('Your plan includes SFTP file access, not a shell.') }}</p>
          <div v-if="data?.ftp" class="flex flex-col gap-3">
            <CopyLine :text="ftpLine" />
            <p class="text-muted-foreground text-xs">{{ t('FTP works too, on port 21 with “explicit TLS”. Prefer SFTP when your app supports it.') }}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2"><HardDriveIcon class="size-4" /> {{ t('Usage') }}</CardTitle>
          <CardDescription v-if="data.usage.diskMeasuredAt">{{ t('Disk measured {d}.', { d: date(data.usage.diskMeasuredAt) }) }}</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <div class="flex justify-between text-sm"><span class="text-muted-foreground">{{ t('Disk') }}</span><span class="font-mono">{{ bytes(data.usage.diskBytes) }} / {{ diskLimit ? bytes(diskLimit) : '∞' }}</span></div>
            <Progress :model-value="diskLimit ? Math.min(100, ((data.usage.diskBytes ?? 0) / diskLimit) * 100) : 0" class="h-1.5" />
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="flex justify-between text-sm"><span class="text-muted-foreground">{{ t('Bandwidth this month') }}</span><span class="font-mono">{{ bytes(data.usage.bandwidthBytes) }} / {{ bandwidthLimit ? bytes(bandwidthLimit) : '∞' }}</span></div>
            <Progress :model-value="bandwidthLimit ? Math.min(100, (data.usage.bandwidthBytes / bandwidthLimit) * 100) : 0" class="h-1.5" />
          </div>
          <p class="text-muted-foreground text-xs">
            {{ t('Preview of your first site:') }} <a :href="data.previewUrl" target="_blank" rel="noreferrer" class="text-foreground font-mono hover:underline">{{ data.previewUrl }}</a>
          </p>
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2"><KeyRoundIcon class="size-4" /> {{ t('PHP settings') }}</CardTitle>
        <CardDescription>{{ t('Apply to all your sites, for every PHP version. Leave a field empty for the default.') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="flex flex-col gap-4" @submit.prevent="savePhp">
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field v-for="[key, label, example] in FIELDS" :key="key">
              <FieldLabel :for="`php-${key}`">{{ t(label) }}</FieldLabel>
              <Input :id="`php-${key}`" v-model="php[key] as string" class="font-mono" :placeholder="example" />
            </Field>
          </div>
          <label class="flex items-center gap-2 text-sm"><Switch :model-value="php.display_errors === true" @update:model-value="(v) => (php.display_errors = v)" /> {{ t('Show PHP errors in pages (for debugging only)') }}</label>
          <div><Button type="submit" :disabled="saving"><Spinner v-if="saving" data-icon="inline-start" /><SaveIcon v-else data-icon="inline-start" /> {{ t('Apply') }}</Button></div>
        </form>
      </CardContent>
    </Card>
  </template>
  <Skeleton v-else-if="!error" class="h-64 rounded-xl" />
</template>
