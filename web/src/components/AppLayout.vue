<script setup lang="ts">
import { useColorMode } from '@vueuse/core'
import {
  ActivityIcon, BoxIcon, ClockIcon, CodeIcon, DatabaseIcon, FolderIcon, GlobeIcon, KeyRoundIcon, LanguagesIcon, MailIcon, LayoutDashboardIcon, LayersIcon, LogOutIcon, MoonIcon, ServerIcon, SettingsIcon,
  ShieldIcon, SunIcon, UndoIcon, UserCogIcon, UsersIcon,
} from '@lucide/vue'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandLogo from '@/components/app/BrandLogo.vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger,
} from '@/components/ui/sidebar'
import { applySession, impersonator, panelName, user, version } from '@/composables/useSession'
import { post } from '@/lib/api'
import { lang, setLang, t, type Lang } from '@/lib/i18n'

const route = useRoute()
const router = useRouter()
const mode = useColorMode({ storageKey: 'webcpl-theme' })

const ROLE_LABEL = { admin: 'Administrator', reseller: 'Reseller', user: 'User' } as const

const groups = computed(() => {
  const role = user.value?.role
  const manage = role === 'admin' || role === 'reseller'
  return [
    {
      label: 'Main',
      links: [
        { to: '/', label: 'Dashboard', icon: LayoutDashboardIcon },
        ...(manage ? [{ to: '/accounts', label: 'Accounts', icon: UsersIcon }, { to: '/plans', label: 'Plans', icon: LayersIcon }] : []),
        { to: '/activity', label: 'Activity', icon: ActivityIcon },
      ],
    },
    ...(user.value?.hostingPlan
      ? [{
          label: 'Hosting',
          links: [
            { to: '/websites', label: 'Websites', icon: GlobeIcon },
            { to: '/files', label: 'Files', icon: FolderIcon },
            { to: '/mail', label: 'Mail', icon: MailIcon },
            { to: '/databases', label: 'Databases', icon: DatabaseIcon },
            { to: '/cron', label: 'Cron jobs', icon: ClockIcon },
            ...(user.value.hostingPlan.limits.apps === true ? [{ to: '/apps', label: 'Apps', icon: CodeIcon }] : []),
            { to: '/access', label: 'Access and PHP', icon: KeyRoundIcon },
          ],
        }]
      : []),
    ...(user.value?.vpsPlan || role !== 'user'
      ? [{ label: 'VPS', links: [{ to: '/vps', label: 'VPS', icon: BoxIcon }] }]
      : []),
    ...(role === 'admin'
      ? [{ label: 'Server', links: [{ to: '/server', label: 'Server', icon: ServerIcon }, { to: '/settings', label: 'Panel settings', icon: SettingsIcon }] }]
      : []),
  ]
})

const active = (to: string) => (to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(`${to}/`))
const title = computed(() => t((route.meta.title as string) ?? ''))

async function signOut() {
  await post('/api/auth/logout').catch(() => null)
  user.value = null
  await router.push('/login')
}

async function returnToSelf() {
  const me = await post<Parameters<typeof applySession>[0]>('/api/auth/return')
  applySession(me)
  await router.push('/accounts')
}
</script>

<template>
  <SidebarProvider>
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" as-child>
              <RouterLink to="/">
                <BrandLogo :size="30" />
                <div class="grid flex-1 text-left leading-tight">
                  <span class="truncate font-semibold">{{ panelName }}</span>
                  <span class="text-muted-foreground truncate text-xs">{{ t('Hosting control panel') }}</span>
                </div>
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup v-for="group in groups" :key="group.label">
          <SidebarGroupLabel>{{ t(group.label) }}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem v-for="link in group.links" :key="link.to">
                <SidebarMenuButton as-child :is-active="active(link.to)" :tooltip="t(link.label)">
                  <RouterLink :to="link.to">
                    <component :is="link.icon" />
                    <span>{{ t(link.label) }}</span>
                  </RouterLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <SidebarMenuButton size="lg" :tooltip="user?.username">
                  <span class="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg border font-mono text-sm uppercase">
                    {{ user?.username.slice(0, 1) }}
                  </span>
                  <div class="grid flex-1 text-left leading-tight">
                    <span class="truncate font-mono text-sm">{{ user?.username }}</span>
                    <span class="text-muted-foreground flex items-center gap-1 truncate text-xs">
                      <ShieldIcon v-if="user?.role === 'admin'" class="size-3" />
                      {{ user ? t(ROLE_LABEL[user.role]) : '' }}
                    </span>
                  </div>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" class="w-56">
                <DropdownMenuLabel class="text-muted-foreground text-xs font-normal">Webcpl {{ version }}</DropdownMenuLabel>
                <DropdownMenuItem as-child>
                  <RouterLink to="/account"><UserCogIcon /> {{ t('My account') }}</RouterLink>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" @select="signOut"><LogOutIcon /> {{ t('Sign out') }}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>

    <SidebarInset>
      <div v-if="impersonator" class="bg-primary text-primary-foreground flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-1.5 text-sm">
        <span>{{ t('You are signed in as {u}.', { u: user?.username ?? '' }) }}</span>
        <Button size="xs" variant="secondary" @click="returnToSelf"><UndoIcon data-icon="inline-start" /> {{ t('Back to {u}', { u: impersonator.username }) }}</Button>
      </div>
      <header class="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger class="-ml-1" />
        <Separator orientation="vertical" class="mr-2 h-4! self-center!" />
        <h1 class="truncate text-sm font-medium">{{ title }}</h1>
        <div class="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="sm" :aria-label="t('Language')"><LanguagesIcon data-icon="inline-start" /> {{ lang.toUpperCase() }}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup :model-value="lang" @update:model-value="(v) => setLang(v as Lang)">
                <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="fr">Français</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" :aria-label="mode === 'dark' ? t('Light') : t('Dark')" @click="mode = mode === 'dark' ? 'light' : 'dark'">
            <SunIcon v-if="mode === 'dark'" />
            <MoonIcon v-else />
          </Button>
        </div>
      </header>
      <main class="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 p-4 md:p-6">
        <RouterView :key="route.fullPath" />
      </main>
    </SidebarInset>
  </SidebarProvider>
</template>
