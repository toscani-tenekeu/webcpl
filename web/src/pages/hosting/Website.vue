<script setup lang="ts">
import { ChevronRightIcon, LockIcon, PlusIcon, SaveIcon, Trash2Icon, XIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import LoadError from '@/components/LoadError.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResource } from '@/composables/useResource'
import { api, messageOf, post, put } from '@/lib/api'
import { date } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { HostingInfo, RRSet, Website } from '@/lib/types'

const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))
const tab = computed(() => String(route.params.tab || 'settings'))
const { data, error, reload } = useResource<{ domains: Website[] }>('/api/domains')
const info = useResource<HostingInfo>('/api/hosting')
const site = computed(() => data.value?.domains.find((d) => d.id === id.value))
const subdomains = computed(() => (data.value?.domains ?? []).filter((d) => d.parentId === id.value))

// ---- settings ----
const php = ref('')
const aliases = ref<string[]>([])
const newAlias = ref('')
watch(site, (s) => {
  if (!s) return
  php.value = s.php
  aliases.value = [...s.aliases]
}, { immediate: true })
const saving = ref(false)

async function update(id: number, body: Record<string, unknown>, done = t('Saved')) {
  saving.value = true
  try {
    await api(`/api/domains/${id}`, { method: 'PATCH', body })
    toast.success(done)
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  saving.value = false
}

function addAlias() {
  const value = newAlias.value.trim().toLowerCase()
  if (value && !aliases.value.includes(value)) aliases.value.push(value)
  newAlias.value = ''
}

const issuing = ref<number | null>(null)
async function issue(d: Website) {
  issuing.value = d.id
  try {
    await post(`/api/domains/${d.id}/ssl`)
    toast.success(t('Certificate issued for {d}', { d: d.name }))
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  issuing.value = null
}

const subLabel = ref('')
const subBusy = ref(false)
async function addSub() {
  subBusy.value = true
  try {
    await post(`/api/domains/${id.value}/subdomains`, { label: subLabel.value })
    subLabel.value = ''
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  subBusy.value = false
}

const removing = ref<Website | null>(null)
const removeOpen = computed({ get: () => !!removing.value, set: (v) => { if (!v) removing.value = null } })
async function remove() {
  const d = removing.value!
  await api(`/api/domains/${d.id}`, { method: 'DELETE', body: { confirm: d.name } })
  toast.success(t('{d} deleted', { d: d.name }))
  if (d.id === id.value) await router.push('/websites')
  else await reload()
}

// ---- DNS ----
const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS']
interface Row { name: string; type: string; ttl: number; value: string }
const rows = ref<Row[]>([])
const original = ref<RRSet[]>([])
const dnsLoading = ref(false)
const dnsError = ref('')
const dnsSaving = ref(false)
const zone = computed(() => site.value?.name ?? '')
const shortName = (name: string) => (name === `${zone.value}.` ? '@' : name.replace(`.${zone.value}.`, ''))
const fullName = (short: string) => (short === '@' || !short ? `${zone.value}.` : `${short.replace(/\.$/, '')}.${zone.value}.`)

async function loadDns() {
  dnsLoading.value = true
  dnsError.value = ''
  try {
    const r = await api<{ rrsets: RRSet[] }>(`/api/domains/${id.value}/dns`)
    original.value = r.rrsets.filter((s) => s.type !== 'SOA')
    rows.value = original.value.flatMap((s) => s.records.map((value) => ({ name: shortName(s.name), type: s.type, ttl: s.ttl, value })))
  } catch (failure) {
    dnsError.value = messageOf(failure)
  }
  dnsLoading.value = false
}
watch([tab, site], () => { if (tab.value === 'dns' && site.value && !site.value.parentId) void loadDns() }, { immediate: true })

async function saveDns() {
  dnsSaving.value = true
  // Rebuild record sets from the rows; sets that disappeared are sent empty, which deletes them.
  const sets = new Map<string, RRSet>()
  for (const r of rows.value) {
    if (!r.value.trim()) continue
    const key = `${fullName(r.name)}|${r.type}`
    const set = sets.get(key) ?? { name: fullName(r.name), type: r.type, ttl: Number(r.ttl) || 3600, records: [] }
    set.records.push(r.value.trim())
    sets.set(key, set)
  }
  for (const o of original.value) if (!sets.has(`${o.name}|${o.type}`)) sets.set(`${o.name}|${o.type}`, { ...o, records: [] })
  try {
    await put(`/api/domains/${id.value}/dns`, { rrsets: [...sets.values()] })
    toast.success(t('DNS records saved'))
    await loadDns()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  dnsSaving.value = false
}

const goTab = (value: string | number) => router.replace(value === 'settings' ? `/websites/${id.value}` : `/websites/${id.value}/${value}`)
</script>

<template>
  <LoadError :message="data ? '' : error" />
  <template v-if="site">
    <nav class="text-muted-foreground flex items-center gap-1 text-sm">
      <RouterLink to="/websites" class="hover:text-foreground">{{ t('Websites') }}</RouterLink>
      <ChevronRightIcon class="size-3.5" />
      <span class="text-foreground font-mono">{{ site.name }}</span>
    </nav>
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-2 font-mono text-2xl font-semibold tracking-tight">
          {{ site.name }}
          <Badge v-if="site.ssl" variant="secondary" class="gap-1 font-sans"><LockIcon class="size-3" /> HTTPS</Badge>
        </h2>
        <p class="text-muted-foreground mt-1 font-mono text-sm">~/{{ site.docroot }}</p>
      </div>
      <Button variant="outline" as-child><a :href="`${site.ssl ? 'https' : 'http'}://${site.name}`" target="_blank" rel="noreferrer">{{ t('Open the site') }}</a></Button>
    </div>

    <Tabs v-if="!site.parentId" :model-value="tab" @update:model-value="goTab">
      <TabsList>
        <TabsTrigger value="settings" class="px-3">{{ t('Settings') }}</TabsTrigger>
        <TabsTrigger value="dns" class="px-3">DNS</TabsTrigger>
      </TabsList>
    </Tabs>

    <template v-if="tab === 'settings'">
      <div class="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>PHP</CardTitle><CardDescription>{{ t('Each website can use its own PHP version.') }}</CardDescription></CardHeader>
          <CardContent class="flex gap-2">
            <Select v-model="php">
              <SelectTrigger class="w-48"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem v-for="v in info.data.value?.phpVersions ?? [site.php]" :key="v" :value="v">PHP {{ v }}</SelectItem></SelectContent>
            </Select>
            <Button :disabled="saving || php === site.php" @click="update(site.id, { php })"><Spinner v-if="saving" data-icon="inline-start" /> {{ t('Apply') }}</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{{ t('Security') }}</CardTitle>
            <CardDescription>
              <template v-if="site.ssl">{{ t('Let’s Encrypt certificate, renewed automatically. Valid until {d}.', { d: date(site.ssl.expiresAt) }) }}</template>
              <template v-else>{{ t('Get a free Let’s Encrypt certificate once the domain points to this server.') }}</template>
            </CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-4">
            <Button :variant="site.ssl ? 'outline' : 'default'" class="self-start" :disabled="issuing === site.id" @click="issue(site)">
              <Spinner v-if="issuing === site.id" data-icon="inline-start" /><LockIcon v-else data-icon="inline-start" />
              {{ site.ssl ? t('Renew the certificate') : t('Get a certificate') }}
            </Button>
            <label class="flex items-center gap-2 text-sm" :class="site.ssl ? '' : 'opacity-50'">
              <Switch :model-value="site.forceHttps" :disabled="!site.ssl || saving" @update:model-value="(v) => update(site!.id, { forceHttps: v })" />
              {{ t('Send every visitor to HTTPS') }}
            </label>
          </CardContent>
        </Card>
      </div>

      <Card v-if="!site.parentId">
        <CardHeader>
          <CardTitle>{{ t('Aliases') }}</CardTitle>
          <CardDescription>{{ t('Other domains that show this same website. Point them to this server too.') }}</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-3">
          <div class="flex flex-wrap gap-2">
            <Badge variant="secondary" class="font-mono">www.{{ site.name }}</Badge>
            <Badge v-for="a in aliases" :key="a" variant="outline" class="gap-1 font-mono">
              {{ a }}
              <button type="button" :aria-label="t('Remove')" @click="aliases = aliases.filter((x) => x !== a)"><XIcon class="size-3" /></button>
            </Badge>
          </div>
          <form class="flex gap-2" @submit.prevent="addAlias">
            <Input v-model="newAlias" class="max-w-80 font-mono" placeholder="example.net" />
            <Button type="submit" variant="outline" :disabled="!newAlias.trim()"><PlusIcon data-icon="inline-start" /> {{ t('Add') }}</Button>
            <Button type="button" :disabled="saving || JSON.stringify(aliases) === JSON.stringify(site.aliases)" @click="update(site!.id, { aliases })">
              <SaveIcon data-icon="inline-start" /> {{ t('Save') }}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card v-if="!site.parentId" class="gap-0 pb-0">
        <CardHeader class="pb-4">
          <CardTitle>{{ t('Subdomains') }}</CardTitle>
          <CardDescription>{{ t('Each subdomain is its own website, in a folder inside this one.') }}</CardDescription>
          <CardAction>
            <form class="flex gap-2" @submit.prevent="addSub">
              <Input v-model="subLabel" class="w-36 font-mono" placeholder="blog" />
              <Button type="submit" variant="outline" :disabled="subBusy || !subLabel.trim()"><Spinner v-if="subBusy" data-icon="inline-start" /><PlusIcon v-else data-icon="inline-start" /> {{ t('Add') }}</Button>
            </form>
          </CardAction>
        </CardHeader>
        <CardContent class="border-t px-0">
          <p v-if="!subdomains.length" class="text-muted-foreground p-4 text-sm">{{ t('No subdomains yet.') }}</p>
          <Table v-else>
            <TableBody>
              <TableRow v-for="d in subdomains" :key="d.id">
                <TableCell class="pl-4 font-mono">{{ d.name }}</TableCell>
                <TableCell class="text-muted-foreground font-mono text-xs">~/{{ d.docroot }}</TableCell>
                <TableCell>
                  <Badge v-if="d.ssl" variant="secondary">HTTPS</Badge>
                  <Button v-else size="sm" variant="ghost" :disabled="issuing === d.id" @click="issue(d)"><Spinner v-if="issuing === d.id" data-icon="inline-start" /> {{ t('Get a certificate') }}</Button>
                </TableCell>
                <TableCell class="pr-4 text-right">
                  <Button size="icon-sm" variant="ghost" class="text-destructive" :aria-label="t('Delete')" @click="removing = d"><Trash2Icon /></Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card class="border-destructive/30">
        <CardHeader>
          <CardTitle class="flex items-center gap-2"><Trash2Icon class="size-4" /> {{ t('Delete this website') }}</CardTitle>
          <CardDescription>{{ t('The site stops answering and its DNS zone is removed. Its files stay in your folder.') }}</CardDescription>
          <CardAction><Button variant="destructive" @click="removing = site"><Trash2Icon data-icon="inline-start" /> {{ t('Delete…') }}</Button></CardAction>
        </CardHeader>
      </Card>
    </template>

    <template v-else-if="tab === 'dns'">
      <LoadError :message="dnsError" />
      <Card v-if="!dnsError" class="gap-0 pb-0">
        <CardHeader class="pb-4">
          <CardTitle>{{ t('DNS records') }}</CardTitle>
          <CardDescription>{{ t('Names are relative to {z}; use @ for the domain itself.', { z: zone }) }}</CardDescription>
          <CardAction class="flex gap-2">
            <Button variant="outline" @click="rows.push({ name: '@', type: 'A', ttl: 3600, value: '' })"><PlusIcon data-icon="inline-start" /> {{ t('Add a record') }}</Button>
            <Button :disabled="dnsSaving" @click="saveDns"><Spinner v-if="dnsSaving" data-icon="inline-start" /><SaveIcon v-else data-icon="inline-start" /> {{ t('Save') }}</Button>
          </CardAction>
        </CardHeader>
        <CardContent class="border-t px-0">
          <Skeleton v-if="dnsLoading && !rows.length" class="m-4 h-40" />
          <Table v-else>
            <TableHeader>
              <TableRow>
                <TableHead class="pl-4">{{ t('Name') }}</TableHead><TableHead>{{ t('Type') }}</TableHead><TableHead>{{ t('Value') }}</TableHead><TableHead>TTL</TableHead><TableHead class="w-10 pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="(r, i) in rows" :key="i">
                <TableCell class="pl-4"><Input v-model="r.name" class="h-8 w-40 font-mono text-xs" /></TableCell>
                <TableCell>
                  <Select v-model="r.type">
                    <SelectTrigger size="sm" class="w-24"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem v-for="ty in TYPES" :key="ty" :value="ty">{{ ty }}</SelectItem></SelectContent>
                  </Select>
                </TableCell>
                <TableCell><Input v-model="r.value" class="h-8 min-w-56 font-mono text-xs" /></TableCell>
                <TableCell><Input v-model.number="r.ttl" class="h-8 w-20 font-mono text-xs" inputmode="numeric" /></TableCell>
                <TableCell class="pr-4"><Button size="icon-sm" variant="ghost" class="text-destructive" :aria-label="t('Delete')" @click="rows.splice(i, 1)"><Trash2Icon /></Button></TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p class="text-muted-foreground border-t px-4 py-3 text-xs">{{ t('MX values look like “10 mail.example.com.”; TXT values go in double quotes.') }}</p>
        </CardContent>
      </Card>
    </template>

    <ConfirmDialog
      v-model:open="removeOpen"
      :title="t('Delete {d}?', { d: removing?.name ?? '' })"
      :description="removing && !removing.parentId ? t('The website, its subdomains and its DNS zone are removed. Its files stay in your folder.') : t('The subdomain stops answering. Its files stay in your folder.')"
      :word="removing?.name"
      :action="t('Delete website')"
      destructive
      :confirm="remove"
    />
  </template>
  <Skeleton v-else-if="!error" class="h-80 rounded-xl" />
</template>
