<script setup lang="ts">
import { ExternalLinkIcon, GlobeIcon, LockIcon, PlusIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import LoadError from '@/components/LoadError.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { messageOf, post } from '@/lib/api'
import { t } from '@/lib/i18n'
import type { HostingInfo, Website } from '@/lib/types'

const router = useRouter()
const { data, error, reload } = useResource<{ domains: Website[] }>('/api/domains')
const info = useResource<HostingInfo>('/api/hosting')
const limit = computed(() => info.data.value?.limits.domains)
const used = computed(() => (data.value?.domains ?? []).filter((d) => !d.parentId).length)
const full = computed(() => typeof limit.value === 'number' && used.value >= limit.value)

const adding = ref(false)
const name = ref('')
const php = ref('')
const busy = ref(false)
const formError = ref('')

function openAdd() {
  name.value = ''
  php.value = info.data.value?.phpVersions.at(-1) ?? ''
  formError.value = ''
  adding.value = true
}

async function add() {
  busy.value = true
  formError.value = ''
  try {
    const r = await post<{ domain: Website }>('/api/domains', { name: name.value, php: php.value })
    adding.value = false
    await reload()
    await router.push(`/websites/${r.domain.id}`)
  } catch (failure) {
    formError.value = messageOf(failure)
  }
  busy.value = false
}
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">{{ t('Websites') }}</h2>
      <p class="text-muted-foreground mt-1 text-sm">
        {{ t('{n} of {m} domains used.', { n: used, m: limit === null || limit === undefined ? '∞' : String(limit) }) }}
        <template v-if="info.data.value">
          {{ t('Before a domain points here, your first site is at') }}
          <a :href="info.data.value.previewUrl" target="_blank" rel="noreferrer" class="text-foreground font-mono hover:underline">{{ info.data.value.previewUrl }}</a>
        </template>
      </p>
    </div>
    <Button :disabled="full" @click="openAdd"><PlusIcon data-icon="inline-start" /> {{ t('Add a domain') }}</Button>
  </div>

  <LoadError :message="data ? '' : error" />

  <Card v-if="data && data.domains.length" class="py-0">
    <CardContent class="px-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="pl-4">{{ t('Domain') }}</TableHead>
            <TableHead>PHP</TableHead>
            <TableHead>{{ t('Security') }}</TableHead>
            <TableHead class="hidden pr-4 md:table-cell">{{ t('Folder') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="d in data.domains" :key="d.id" class="cursor-pointer" @click="router.push(`/websites/${d.parentId ?? d.id}`)">
            <TableCell class="pl-4" :class="d.parentId ? 'pl-10' : ''">
              <div class="flex items-center gap-2">
                <GlobeIcon class="text-muted-foreground size-4" />
                <span class="font-mono font-medium">{{ d.name }}</span>
                <a :href="`http://${d.name}`" target="_blank" rel="noreferrer" class="text-muted-foreground hover:text-foreground" :aria-label="t('Open')" @click.stop><ExternalLinkIcon class="size-3.5" /></a>
              </div>
              <p v-if="d.aliases.length" class="text-muted-foreground mt-0.5 truncate text-xs">{{ d.aliases.join(', ') }}</p>
            </TableCell>
            <TableCell class="font-mono">{{ d.php }}</TableCell>
            <TableCell>
              <Badge v-if="d.ssl" variant="secondary" class="gap-1"><LockIcon class="size-3" /> HTTPS</Badge>
              <span v-else class="text-muted-foreground text-sm">HTTP</span>
            </TableCell>
            <TableCell class="text-muted-foreground hidden max-w-72 truncate pr-4 font-mono text-xs md:table-cell">~/{{ d.docroot }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>
  <Card v-else-if="data">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><GlobeIcon /></EmptyMedia>
        <EmptyTitle>{{ t('No website yet') }}</EmptyTitle>
        <EmptyDescription>{{ t('Add a domain to create its website, its folder and its DNS records.') }}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent><Button @click="openAdd"><PlusIcon data-icon="inline-start" /> {{ t('Add a domain') }}</Button></EmptyContent>
    </Empty>
  </Card>
  <Skeleton v-else-if="!error" class="h-48 rounded-xl" />

  <Dialog v-model:open="adding">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t('Add a domain') }}</DialogTitle>
        <DialogDescription>{{ t('The website works as soon as the domain points to this server.') }}</DialogDescription>
      </DialogHeader>
      <form id="add-domain" class="flex flex-col gap-4" @submit.prevent="add">
        <Field>
          <FieldLabel for="dom-name">{{ t('Domain') }}</FieldLabel>
          <Input id="dom-name" v-model="name" class="font-mono" placeholder="example.com" autocomplete="off" spellcheck="false" />
          <FieldDescription>{{ t('www is included.') }}</FieldDescription>
        </Field>
        <Field v-if="info.data.value">
          <FieldLabel>{{ t('PHP version') }}</FieldLabel>
          <Select v-model="php">
            <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem v-for="v in info.data.value.phpVersions" :key="v" :value="v">PHP {{ v }}</SelectItem></SelectContent>
          </Select>
        </Field>
        <FieldError v-if="formError">{{ formError }}</FieldError>
      </form>
      <DialogFooter>
        <Button variant="outline" @click="adding = false">{{ t('Cancel') }}</Button>
        <Button type="submit" form="add-domain" :disabled="busy || !name.trim()"><Spinner v-if="busy" data-icon="inline-start" /> {{ t('Add') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
