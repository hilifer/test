<template>
  <div>
    <div class="flex justify-between items-center mb-6">
      <h1 class="text-3xl font-bold">Active Sessions</h1>
      <UButton
        v-if="sessions.length > 1"
        color="error"
        variant="soft"
        :loading="revokingAll"
        @click="handleRevokeAll"
      >
        Revoke All Other Sessions
      </UButton>
    </div>

    <p class="text-gray-500 mb-4">
      You have {{ sessions.length }} active session(s). You can revoke sessions from other devices here.
    </p>

    <div v-if="loading" class="text-center py-8 text-gray-500">Loading sessions...</div>

    <div v-else class="flex flex-col gap-4">
      <UCard v-for="session in sessions" :key="session.id">
        <div class="flex justify-between items-start">
          <div class="flex flex-col gap-1">
            <div class="flex items-center gap-2">
              <span class="font-medium">{{ parseDevice(session.device_info) }}</span>
              <UBadge v-if="session.is_current" color="success" size="sm">Current</UBadge>
            </div>
            <p class="text-sm text-gray-500">IP: {{ session.ip_address || 'Unknown' }}</p>
            <p class="text-sm text-gray-500">Login: {{ formatDate(session.created_at) }}</p>
            <p class="text-sm text-gray-500">Last active: {{ formatDate(session.last_active_at) }}</p>
          </div>
          <UButton
            v-if="!session.is_current"
            color="error"
            variant="ghost"
            size="sm"
            :loading="revokingId === session.id"
            @click="handleRevoke(session.id)"
          >
            Revoke
          </UButton>
        </div>
      </UCard>
    </div>

    <p v-if="msg" :class="msgError ? 'text-red-500' : 'text-green-500'" class="text-sm mt-4">
      {{ msg }}
    </p>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: ['auth'] })
const { listSessions, revokeSession, revokeOtherSessions } = useAuth()

const sessions = ref<any[]>([])
const loading = ref(true)
const revokingId = ref<number | null>(null)
const revokingAll = ref(false)
const msg = ref('')
const msgError = ref(false)

async function loadSessions() {
  loading.value = true
  try {
    sessions.value = await listSessions()
  } catch {
    sessions.value = []
  } finally {
    loading.value = false
  }
}

async function handleRevoke(id: number) {
  revokingId.value = id
  msg.value = ''
  try {
    await revokeSession(id)
    msg.value = 'Session revoked'
    msgError.value = false
    await loadSessions()
  } catch (e: any) {
    msg.value = e?.data?.detail || 'Failed to revoke session'
    msgError.value = true
  } finally {
    revokingId.value = null
  }
}

async function handleRevokeAll() {
  revokingAll.value = true
  msg.value = ''
  try {
    await revokeOtherSessions()
    msg.value = 'All other sessions revoked'
    msgError.value = false
    await loadSessions()
  } catch (e: any) {
    msg.value = e?.data?.detail || 'Failed to revoke sessions'
    msgError.value = true
  } finally {
    revokingAll.value = false
  }
}

function parseDevice(ua: string) {
  if (!ua) return 'Unknown device'
  if (ua.length > 80) return ua.substring(0, 80) + '...'
  return ua
}

function formatDate(dateStr?: string) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString()
}

onMounted(loadSessions)
</script>
